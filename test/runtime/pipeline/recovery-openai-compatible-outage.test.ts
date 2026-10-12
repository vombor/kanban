// An OpenAI-compatible provider of config.json (the user's Triton router) runs on another host: one that can't be
// reached must read as a provider outage (backoff retries, then recovery's outage hold with model-list probes), never
// as the model's error. The error texts are Cline 3.0.70's, word for word, from real TUI runs against a refusing port,
// a socket-resetting server and an unresolvable name (throwaway CLINE_DIR, 2026-10-11): each is an error notice
// (`displayRole: "error"`, an `error_` id).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import { canProbeProvider, probeModel } from "../../../src/models/model-probe";
import { setConfiguredOpenAiCompatibleProviders } from "../../../src/models/openai-compatible-providers";
import {
	applyOutageProbe,
	decideRecovery,
	type RecoveryCardInput,
	readRecoveryFlow,
} from "../../../src/pipeline/recovery";
import { detectFinalProviderError, isRetryableProviderError } from "../../../src/pipeline/recovery-detect";
import type { ClineSessionDetail, ClineSessionDetailMessage } from "../../../src/terminal/cline-session-files";
import {
	type FakeOpenAiCompatibleServer,
	getRefusingOpenAiCompatibleBaseUrl,
	startFakeOpenAiCompatibleServer,
	tritonProvider,
} from "../../utilities/openai-compatible-fixtures";

const NOW = Date.parse("2026-10-11T23:40:00.000Z");
const MIN = 60_000;
const settings = parsePipelineConfig({}).config.pipeline.recovery;
const MODEL = { provider: "triton", model: "qwen3.6-35b-a3b" };

const CLINE_UNREACHABLE_ERRORS = {
	refused:
		"Cannot connect to API: Unable to connect. Is the computer able to access the url?: TypeError: Unable to connect. Is the computer able to access the url? (ConnectionRefused)",
	reset: "Cannot connect to API: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch(): TypeError: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch() (ECONNRESET)",
	dns: "getaddrinfo ENOTFOUND triton-nonexistent.invalid",
};

const card = {
	id: "dev1",
	title: "Do the thing",
	prompt: "Implement the thing.",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 0,
	updatedAt: 0,
} as RuntimeBoardCard;

function message(
	role: string,
	text: string,
	extra: Partial<ClineSessionDetailMessage> = {},
): ClineSessionDetailMessage {
	return { role, content: [{ type: "text", text }], outputTokens: null, ts: null, ...extra };
}

function erroredTurn(text: string): ClineSessionDetail {
	const messages = [message("user", "go"), message("assistant", text, { displayError: true })];
	const writtenAt = NOW - 2 * MIN;
	return {
		snapshot: {
			sessionId: "1791761438608_rim3h",
			// The TUI's session stays "idle" after the error.
			status: "idle",
			startedAt: NOW - 10 * MIN,
			messagesWrittenAt: writtenAt,
			lastMessage: { role: "assistant", content: messages[1]?.content ?? [], displayError: true },
		},
		messages,
		lastWriteAt: writtenAt,
	};
}

function input(overrides: Partial<RecoveryCardInput> = {}): RecoveryCardInput {
	return {
		card,
		column: "review",
		role: "dev",
		model: MODEL,
		session: {
			taskId: "dev1",
			agentId: "cline",
			modelId: MODEL.model,
			state: "awaiting_review",
			reviewReason: "hook",
			live: true,
		},
		detail: erroredTurn(CLINE_UNREACHABLE_ERRORS.refused),
		readsTurnOutcome: true,
		profile: { clearContextCommand: "/clear", cancelTurnInput: "\u001b" },
		flow: readRecoveryFlow(undefined),
		canProbe: true,
		capacityHold: null,
		slowFirstCall: true,
		continuesPrematureStops: true,
		settings,
		now: NOW,
		...overrides,
	};
}

describe("recovery: an unreachable OpenAI-compatible server is a provider outage", () => {
	let server: FakeOpenAiCompatibleServer | null = null;
	beforeAll(() => {
		setConfiguredOpenAiCompatibleProviders({ triton: tritonProvider("http://triton.test/v1") });
	});
	afterAll(() => {
		setConfiguredOpenAiCompatibleProviders({});
	});
	afterEach(async () => {
		await server?.close();
		server = null;
	});

	it("reads Cline's refused, reset and DNS errors as retryable provider errors", () => {
		for (const text of Object.values(CLINE_UNREACHABLE_ERRORS)) {
			const error = detectFinalProviderError(erroredTurn(text).messages);
			expect(error, text).not.toBeNull();
			expect(error && isRetryableProviderError(error), text).toBe(true);
		}
	});

	it("retries with backoff, then holds for an outage (a configured provider has a probe), never a model error", () => {
		expect(canProbeProvider(MODEL.provider)).toBe(true);
		for (const text of Object.values(CLINE_UNREACHABLE_ERRORS)) {
			const first = decideRecovery(input({ detail: erroredTurn(text) }));
			expect(first.kind, text).toBe("hold");
			expect(first.kind === "hold" ? first.patch.retryAt : null).toBe(new Date(NOW + MIN).toISOString());

			const usedUp = readRecoveryFlow({
				qaflow: { transient: [1, 2, 3, 4].map((n) => ({ at: `2026-10-11T23:0${n}:00.000Z`, warn: text })) },
			});
			const hold = decideRecovery(input({ detail: erroredTurn(text), flow: usedUp }));
			expect(hold.kind, text).toBe("hold");
			expect(hold.kind === "hold" ? hold.patch.outage : null).toMatchObject({
				model: "triton/qwen3.6-35b-a3b",
				ups: 0,
			});
		}
	});

	it("probes the server while it refuses connections (down, the hold stays) and resumes once it answers again", async () => {
		const outage = {
			since: new Date(NOW - 20 * MIN).toISOString(),
			model: "triton/m",
			warn: "x",
			ups: 0,
			lastProbe: null,
		};
		const flow = readRecoveryFlow({ qaflow: { outage } });
		expect(decideRecovery(input({ flow })).kind).toBe("probe");

		const deps = { bedrock: null, lemonadeBaseUrl: "http://lemonade.test/api/v1" };
		setConfiguredOpenAiCompatibleProviders({ triton: tritonProvider(await getRefusingOpenAiCompatibleBaseUrl()) });
		const down = await probeModel(MODEL, deps);
		expect(down.up).toBe(false);
		const stillDown = applyOutageProbe(flow, down.up, settings, NOW);
		expect(stillDown).toMatchObject({ resumed: false, patch: { outage: { ups: 0 } } });

		server = await startFakeOpenAiCompatibleServer();
		setConfiguredOpenAiCompatibleProviders({ triton: tritonProvider(server.baseUrl) });
		const up = await probeModel(MODEL, deps);
		expect(up.up).toBe(true);
		let state = flow;
		let result = applyOutageProbe(state, true, settings, NOW);
		for (let probe = 1; !result.resumed && probe < settings.outage.upsToResume; probe += 1) {
			state = readRecoveryFlow({ qaflow: { ...result.patch } });
			result = applyOutageProbe(state, true, settings, NOW + probe * MIN);
		}
		expect(result.resumed).toBe(true);
		expect(server.requests.every((path) => path === "/v1/models")).toBe(true);
	});
});
