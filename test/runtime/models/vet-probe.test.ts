import { describe, expect, it } from "vitest";

import { fetchLemonadeModelLoaded } from "../../../src/models/lemonade-models";
import { createVetProbe, type VetProbeInput, type VetProbeOptions } from "../../../src/models/vetting/vet-probe";
import { createAgentToolProcessFinder } from "../../../src/server/process-reaper";
import type { ClineSessionDetail, ClineSessionDetailMessage } from "../../../src/terminal/cline-session-files";
import { createFakeProcessTable, createProcessEntry } from "../../utilities/fake-process-table";
import {
	createFakeLemonadeFetch,
	LEMONADE_HEALTH_IDLE_PAYLOAD,
	LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD,
} from "../../utilities/lemonade-fixtures";

const MIN = 60_000;
const START = Date.parse("2026-10-09T06:37:06.000Z");
const WORKTREE = "/worktrees/a9a77/repo";
const GLM = "GLM-4.7-Flash-GGUF";
const QWEN = "Qwen3.6-35B-A3B-MTP-GGUF";

function message(role: string, content: ClineSessionDetailMessage["content"], ts: number): ClineSessionDetailMessage {
	return { role, content, outputTokens: null, ts };
}

const prompt = message("user", [{ type: "text", text: "do the task" }], START + 5_000);

function session(status: string, messages: ClineSessionDetailMessage[]): ClineSessionDetail {
	const writtenAt = Math.max(...messages.map((entry) => entry.ts ?? 0));
	return {
		snapshot: { sessionId: "1791527831210_oysap", status, startedAt: START + 4_000, messagesWrittenAt: writtenAt },
		messages,
		lastWriteAt: writtenAt,
	} as ClineSessionDetail;
}

function probeWith(detail: ClineSessionDetail | null, options: VetProbeOptions = {}) {
	return createVetProbe({ hungMin: 15, reader: { readLatestSessionDetail: async () => detail }, ...options });
}

function input(overrides: Partial<VetProbeInput> = {}): VetProbeInput {
	return {
		agentId: "cline",
		worktreePath: WORKTREE,
		providerId: "lemonade",
		model: GLM,
		agentPid: 4100,
		runStartedAt: START,
		kanbanProgressAt: START,
		stallMin: 8,
		now: START + 9 * MIN,
		...overrides,
	};
}

describe("kanban models vet: the probe", () => {
	it("doesn't take a first reply that waits on a model Lemonade is still loading for a silent stall (GLM dev, 10/09)", async () => {
		const loading = createFakeLemonadeFetch({ health: LEMONADE_HEALTH_IDLE_PAYLOAD });
		const isLemonadeModelLoaded = async (model: string) =>
			await fetchLemonadeModelLoaded("http://lemonade.test/api/v1", model, loading);
		// The live case: the session file still "running", no reply 8 min after the prompt.
		const running = await probeWith(session("running", [prompt]), { isLemonadeModelLoaded })(input());
		expect(running).toEqual({ failure: null, hold: `lemonade is still loading ${GLM}` });
		expect(loading.urls).toEqual(["http://lemonade.test/api/v1/health"]);
		// An idle session file waiting on a model that is still loading: no stall at all, however long.
		const idle = await probeWith(session("idle", [prompt]), { isLemonadeModelLoaded })(
			input({ now: START + 25 * MIN }),
		);
		expect(idle).toEqual({ failure: null, hold: `lemonade is still loading ${GLM}` });
	});

	it("gives a local model's first reply the load allowance before its silence counts", async () => {
		const loaded = createFakeLemonadeFetch({
			health: { ...LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD, model_loaded: QWEN },
		});
		const options: VetProbeOptions = {
			isLemonadeModelLoaded: async (model) =>
				await fetchLemonadeModelLoaded("http://lemonade.test/api/v1", model, loaded),
		};
		const detail = session("idle", [prompt]);
		// 9 min quiet: within stallMin + the 10 min first-reply allowance.
		expect((await probeWith(detail, options)(input({ model: QWEN })))?.failure).toBeNull();
		const late = await probeWith(detail, options)(input({ model: QWEN, now: START + 5_000 + 19 * MIN }));
		expect(late?.failure).toMatchObject({ kind: "silent_stall", detail: expect.stringContaining("no reply") });
		expect(late?.failure?.harness).toBeUndefined();
		// A cloud provider gets no allowance.
		expect((await probeWith(detail)(input({ providerId: "bedrock", model: "x" })))?.failure?.kind).toBe(
			"silent_stall",
		);
		// The hung check still owns a request in flight once the model is loaded, with its own first-call limit.
		const hung = await probeWith(
			session("running", [prompt]),
			options,
		)(input({ model: QWEN, now: START + 36 * MIN }));
		expect(hung?.failure).toMatchObject({ kind: "hung_request", harness: true });
	});

	it("doesn't stall a shell tool whose command still runs (fake process table)", async () => {
		const call = message("assistant", [{ type: "tool_use", name: "run_commands" }], START + 30_000);
		const detail = session("running", [prompt, call]);
		const table = createFakeProcessTable([
			createProcessEntry({ pid: 4100, command: "cline --tui" }),
			createProcessEntry({ pid: 4200, ppid: 4100, command: "ls -R", cwd: WORKTREE }),
		]);
		const findRunningTool = createAgentToolProcessFinder(table.reader);
		const now = START + 20 * MIN;
		expect(await probeWith(detail, { findRunningTool })(input({ now }))).toEqual({
			failure: null,
			hold: "the tool's command still runs (pid 4200: ls -R)",
		});
		table.processes.delete(4200);
		expect((await probeWith(detail, { findRunningTool })(input({ now })))?.failure?.kind).toBe("silent_stall");
	});

	it("tells a local provider's timeout (retried by the runner) from a model's provider error", async () => {
		const timeout = session("idle", [
			prompt,
			message("assistant", [{ type: "text", text: "The operation timed out." }], START + 5 * MIN),
		]);
		const loading = await probeWith(timeout, { isLemonadeModelLoaded: async () => false })(
			input({ model: "Devstral-Small-2507-GGUF" }),
		);
		expect(loading?.failure).toEqual({
			kind: "provider_timeout",
			detail: "provider timeout while lemonade loads Devstral-Small-2507-GGUF: The operation timed out.",
			harness: true,
			occurrence: "1791527831210_oysap:2",
		});
		const loaded = await probeWith(timeout, { isLemonadeModelLoaded: async () => true })(input());
		expect(loaded?.failure).toMatchObject({
			kind: "provider_timeout",
			detail: expect.stringContaining("on lemonade"),
		});
		// On a cloud provider a timeout is a provider error (an environment one: transient).
		expect((await probeWith(timeout)(input({ providerId: "bedrock" })))?.failure).toMatchObject({
			kind: "provider_error",
			harness: true,
		});
	});

	it("takes a turn that ends on a provider or transport error for the environment's, not the model's (issue #25)", async () => {
		const notice = (text: string) => ({
			...message("assistant", [{ type: "text", text }], START + 5 * MIN),
			displayError: true,
		});
		// Lemonade evicted the model for another project's card; Cline shows the error in place of a reply.
		const evicted = await probeWith(session("idle", [prompt, notice("No model loaded: Devstral-Small-2507-GGUF")]))(
			input({ model: "Devstral-Small-2507-GGUF" }),
		);
		expect(evicted?.failure).toEqual({
			kind: "provider_error",
			detail: "No model loaded: Devstral-Small-2507-GGUF",
			harness: true,
		});
		const cut = await probeWith(session("idle", [prompt, notice("Response stream ended without a finish reason.")]))(
			input(),
		);
		expect(cut?.failure).toMatchObject({ kind: "provider_error", harness: true });
		// llama.cpp's overflow, on a model instance shared with another project's QA card.
		const overflow = await probeWith(session("idle", [prompt, notice("Context size has been exceeded.")]))(
			input({ model: "Gemma-4-12B-it-GGUF" }),
		);
		expect(overflow?.failure).toEqual({
			kind: "context_overflow",
			detail: "Context size has been exceeded.",
			harness: true,
		});
		// A rejected request over the model's own malformed tool call stays the model's.
		const invalid = await probeWith(session("idle", [prompt, notice("ValidationException: invalid tool use block")]))(
			input({ providerId: "bedrock" }),
		);
		expect(invalid?.failure).toMatchObject({ kind: "provider_error", harness: false });
		// The same text written by the model itself is its reply, not an error notice.
		const reply = await probeWith(
			session("idle", [
				prompt,
				message("assistant", [{ type: "text", text: "No model loaded: I can't help." }], START + 5 * MIN),
			]),
		)(input());
		expect(reply?.failure ?? null).toBeNull();
	});

	it("answers null for an agent whose session files it can't read", async () => {
		expect(await probeWith(null)(input({ agentId: "codex" }))).toBeNull();
	});
});

describe("Lemonade: whether a model is loaded", () => {
	it("reads /api/v1/health, and can't tell when Lemonade is down", async () => {
		const base = "http://lemonade.test/api/v1";
		const qwen = createFakeLemonadeFetch({ health: LEMONADE_HEALTH_QWEN_LOADED_PAYLOAD });
		expect(await fetchLemonadeModelLoaded(base, QWEN, qwen)).toBe(true);
		expect(await fetchLemonadeModelLoaded(base, GLM, qwen)).toBe(false);
		expect(await fetchLemonadeModelLoaded(base, GLM, createFakeLemonadeFetch({ down: true }))).toBeNull();
		expect(await fetchLemonadeModelLoaded(base, GLM, createFakeLemonadeFetch({ missing: ["health"] }))).toBeNull();
	});
});
