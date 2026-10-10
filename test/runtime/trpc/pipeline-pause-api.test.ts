// `kanban pipeline pause|resume` (issue #23): who may ask, what the config and the decision log get, and what the
// worker and the browser are told.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getWorkspacePipelineSettings, parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { AgentSessionIdentity, RuntimeCaller } from "../../../src/isolation/session-identity";
import type { PipelineDecisionRecord } from "../../../src/pipeline/decision-log";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createPipelinePauseApi, decidePipelinePauseCaller } from "../../../src/trpc/pipeline-pause-api";
import { createTempDir } from "../../utilities/temp-dir";

function session(workspaceId: string, role: AgentSessionIdentity["role"], taskId: string): RuntimeCaller {
	return {
		kind: "session",
		via: "credential",
		session: { workspaceId, taskId, role, agentId: "claude", cwd: `/projects/${workspaceId}` },
	};
}

const USER: RuntimeCaller = { kind: "user" };
const OWN_ORCHESTRATOR = session("notes", "orchestrator", "__home_agent__:notes:claude");
const OTHER_ORCHESTRATOR = session("foo", "orchestrator", "__home_agent__:foo:claude");
const OWN_CARD = session("notes", "card", "d1111");
const UNKNOWN: RuntimeCaller = { kind: "unknown", reason: "a credential outside its session's process tree" };
const NOW = Date.parse("2026-10-10T09:30:00.000Z");

describe("pipeline pause caller rules", () => {
	it("allows the user and the project's own orchestrator, refuses everyone else", () => {
		expect(decidePipelinePauseCaller(USER, "notes")).toEqual({ allowed: true, by: "user" });
		expect(decidePipelinePauseCaller(OWN_ORCHESTRATOR, "notes")).toEqual({
			allowed: true,
			by: "orchestrator __home_agent__:notes:claude",
		});
		const refused = (caller: RuntimeCaller) => {
			const decision = decidePipelinePauseCaller(caller, "notes");
			return decision.allowed ? "allowed" : decision.message;
		};
		expect(refused(OTHER_ORCHESTRATOR)).toContain("not the orchestrator of foo");
		expect(refused(OWN_CARD)).toContain("card d1111 of notes can't");
		expect(refused(UNKNOWN)).toContain("an unidentified agent session");
	});
});

describe("pipeline pause api", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	function setup(config: unknown) {
		const temp = createTempDir("kanban-pause-");
		cleanups.push(temp.cleanup);
		const configPath = join(temp.path, "config.json");
		writeFileSync(configPath, JSON.stringify(config, null, 2));
		const decisions: PipelineDecisionRecord[] = [];
		const refusals: Array<{ action: string; kind: string }> = [];
		const requestSnapshot = vi.fn();
		const broadcastProjects = vi.fn();
		const api = createPipelinePauseApi({
			log: async (_workspaceIds, record) => {
				refusals.push({ action: record.action, kind: record.kind });
			},
			requestSnapshot,
			broadcastProjects,
			decisionLog: {
				append: async (records) => {
					decisions.push(...records);
				},
			},
			configPath,
			now: () => NOW,
		});
		const readRaw = () => JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
		const readSettings = (workspaceId: string) =>
			getWorkspacePipelineSettings(parsePipelineConfig(readRaw()).config, workspaceId);
		return { api, decisions, refusals, requestSnapshot, broadcastProjects, readRaw, readSettings };
	}

	const QA_NOTES = { landing: { mode: "qa" }, kit: { name: "team-local" } };

	it("pauses one workspace only, logs who and why, and tells the worker and the browser", async () => {
		const { api, decisions, requestSnapshot, broadcastProjects, readSettings } = setup({
			workspaces: { notes: QA_NOTES, foo: { landing: { mode: "qa" } } },
		});

		const paused = await api.setPaused({
			caller: OWN_ORCHESTRATOR,
			workspaceId: "notes",
			request: { paused: true, reason: "QA calibration" },
		});
		expect(paused).toMatchObject({ ok: true, paused: true, changed: true, pausedAt: "2026-10-10T09:30:00.000Z" });
		expect(paused.message).toContain("Resume with `kanban pipeline resume`");
		expect(readSettings("notes").pipeline).toEqual({
			shadow: false,
			paused: true,
			pausedAt: "2026-10-10T09:30:00.000Z",
		});
		expect(readSettings("foo").pipeline.paused).toBe(false);
		expect(decisions).toMatchObject([
			{
				workspaceId: "notes",
				taskId: null,
				stage: "pause",
				kit: "team-local",
				landingMode: "qa",
				answer: { by: "orchestrator __home_agent__:notes:claude", paused: true, reason: "QA calibration" },
				outcome: "acted",
				note: expect.stringContaining(
					"QA pipeline paused by orchestrator __home_agent__:notes:claude (QA calibration)",
				),
			},
		]);
		expect(requestSnapshot.mock.calls).toEqual([["notes"]]);
		expect(broadcastProjects.mock.calls).toEqual([["notes"]]);

		// Asked again: nothing written, nothing logged, the pause keeps its time.
		const again = await api.setPaused({ caller: USER, workspaceId: "notes", request: { paused: true } });
		expect(again).toMatchObject({ ok: true, paused: true, changed: false, pausedAt: "2026-10-10T09:30:00.000Z" });
		expect(again.message).toContain("Already paused since 2026-10-10T09:30:00.000Z");
		expect(decisions).toHaveLength(1);
		expect(requestSnapshot).toHaveBeenCalledTimes(1);
	});

	it("resumes by removing the keys it wrote, keeping the rest of the entry", async () => {
		const { api, decisions, requestSnapshot, readRaw } = setup({
			workspaces: { notes: { ...QA_NOTES, pipeline: { shadow: true } } },
		});
		await api.setPaused({ caller: USER, workspaceId: "notes", request: { paused: true } });
		const resumed = await api.setPaused({ caller: USER, workspaceId: "notes", request: { paused: false } });

		expect(resumed).toMatchObject({ ok: true, paused: false, changed: true, pausedAt: null });
		expect(readRaw().workspaces).toEqual({ notes: { ...QA_NOTES, pipeline: { shadow: true } } });
		expect(decisions.map((record) => [record.answer, record.shadow, record.note])).toEqual([
			[{ by: "user", paused: true, reason: null }, true, expect.stringContaining("QA pipeline paused by user:")],
			[{ by: "user", paused: false, reason: null }, true, expect.stringContaining("QA pipeline resumed by user:")],
		]);
		expect(requestSnapshot).toHaveBeenCalledTimes(2);

		const notPaused = await api.setPaused({ caller: USER, workspaceId: "notes", request: { paused: false } });
		expect(notPaused).toMatchObject({ ok: true, changed: false, message: expect.stringContaining("Not paused") });
	});

	it("says so for a workspace the pipeline doesn't QA, and leaves no empty entry after the resume", async () => {
		const { api, readRaw } = setup({});
		const paused = await api.setPaused({ caller: USER, workspaceId: "bare", request: { paused: true } });
		expect(paused.message).toContain("bare is on landing mode off, so the pipeline QAs nothing there");
		expect(readRaw().workspaces).toEqual({
			bare: { pipeline: { paused: true, pausedAt: "2026-10-10T09:30:00.000Z" } },
		});
		await api.setPaused({ caller: USER, workspaceId: "bare", request: { paused: false } });
		expect(readRaw().workspaces).toEqual({});
	});

	it("refuses a card, another project's orchestrator and an unknown caller, logging each and writing nothing", async () => {
		const { api, decisions, refusals, requestSnapshot, readRaw } = setup({ workspaces: { notes: QA_NOTES } });
		for (const caller of [OWN_CARD, OTHER_ORCHESTRATOR, UNKNOWN]) {
			const response = await api.setPaused({ caller, workspaceId: "notes", request: { paused: true } });
			expect(response.ok).toBe(false);
		}
		expect(refusals).toEqual([
			{ action: "pipeline.pause", kind: "refused" },
			{ action: "pipeline.pause", kind: "refused" },
			{ action: "pipeline.pause", kind: "refused" },
		]);
		expect(readRaw().workspaces).toEqual({ notes: QA_NOTES });
		expect(decisions).toEqual([]);
		expect(requestSnapshot).not.toHaveBeenCalled();
	});

	it("is reached through pipeline.setPaused with the strict caller", async () => {
		const setPaused = vi.fn(async () => ({ ok: true, paused: true, changed: true, pausedAt: null }));
		const caller = runtimeAppRouter.createCaller({
			requestedWorkspaceId: "notes",
			workspaceScope: { workspaceId: "notes", workspacePath: "/projects/notes" },
			getCaller: async (): Promise<RuntimeCaller> => USER,
			resolveStrictCaller: async () => OWN_CARD,
			pipelinePauseApi: { setPaused },
		} as unknown as RuntimeTrpcContext);
		await caller.pipeline.setPaused({ paused: true });
		expect(setPaused.mock.calls).toEqual([[{ caller: OWN_CARD, workspaceId: "notes", request: { paused: true } }]]);
	});
});
