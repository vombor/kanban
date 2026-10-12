// `kanban restart update`'s server route (src/trpc/restart-update-api.ts): who may run it, its refusals, and the
// prepare + exit 75 that restart the container onto the newer image.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkspaceStateResponse } from "../../../src/core/api-contract";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import type { PrepareWorkspaceRestartInput } from "../../../src/pipeline/restart-prepare";
import {
	type CreateRestartUpdateApiDependencies,
	createRestartUpdateApi,
	KANBAN_UPDATE_RESTART_EXIT_CODE,
	type RestartUpdateLogEntry,
} from "../../../src/trpc/restart-update-api";

const KANBAN = "kanban-2uge";
const OLD = { revision: "aaaaaaa1111", created: "2026-10-11T06:20:00.000Z", digest: null };
const NEW = { revision: "bbbbbbb2222", created: "2026-10-12T06:20:00.000Z", digest: "sha256:new" };

function session(workspaceId: string, role: "orchestrator" | "card") {
	return {
		kind: "session",
		session: {
			workspaceId,
			taskId: role === "orchestrator" ? `__home_agent__:${workspaceId}:claude` : "t1",
			role,
			agentId: "claude",
			cwd: `/projects/${workspaceId}`,
		},
		via: "credential",
	} satisfies RuntimeCaller;
}

function boardWith(inProgress: string[]): RuntimeWorkspaceStateResponse {
	return {
		board: {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: inProgress.map((id) => ({ id })) },
				{ id: "review", title: "Review", cards: [] },
			],
		},
		sessions: {},
	} as unknown as RuntimeWorkspaceStateResponse;
}

function harness(overrides: Partial<CreateRestartUpdateApiDependencies> & { inProgress?: string[] } = {}) {
	const logEntries: RestartUpdateLogEntry[] = [];
	const prepared: PrepareWorkspaceRestartInput[] = [];
	const requestExit = vi.fn();
	const isolationLog = vi.fn(async () => {});
	const warn = vi.fn();
	const api = createRestartUpdateApi({
		log: isolationLog,
		warn,
		listWorkspaces: async () => [
			{ workspaceId: KANBAN, repoPath: "/projects/kanban" },
			{ workspaceId: "foo", repoPath: "/projects/foo" },
		],
		loadState: async (target) => boardWith(target.workspaceId === "foo" ? (overrides.inProgress ?? []) : []),
		requestExit,
		readSetupWorkspaceId: async () => KANBAN,
		isInContainer: () => true,
		readRunningBuild: () => OLD,
		fetchLatestBuild: async () => NEW,
		describeRecovery: async () => "restart recovery resumes it",
		prepareWorkspace: async (input) => {
			prepared.push(input);
			input.print(`${input.target.workspaceId}: wrote the manifest`);
			return 0;
		},
		appendLog: async (entry) => {
			logEntries.push(entry);
		},
		exitDelayMs: 50,
		...overrides,
	});
	return { api, logEntries, prepared, requestExit, isolationLog, warn };
}

const request = (overrides: { force?: boolean; dryRun?: boolean } = {}) => ({
	force: false,
	dryRun: false,
	...overrides,
});

afterEach(() => {
	vi.useRealTimers();
});

describe("restart.update", () => {
	it("refuses a card, another project's orchestrator and an unidentified caller, and logs them", async () => {
		const { api, logEntries, isolationLog, requestExit, prepared } = harness();
		const callers: RuntimeCaller[] = [
			session(KANBAN, "card"),
			session("foo", "orchestrator"),
			{ kind: "unknown", reason: "no session above the caller" },
		];
		for (const caller of callers) {
			const response = await api.update(caller, request({ force: true }));
			expect(response.status).toBe("refused");
			expect(response.message).toContain("restarts the pod's container onto a newer image");
			expect(response.message).toContain("only the user or the Kanban project's orchestrator");
		}
		expect(isolationLog).toHaveBeenCalledWith(
			[KANBAN, "foo"],
			expect.objectContaining({ kind: "refused", action: "restart.update", from: "foo" }),
		);
		expect(logEntries.map((entry) => entry.status)).toEqual(["refused", "refused", "refused"]);
		expect(logEntries[1]?.caller).toBe("the orchestrator of foo");
		expect(prepared).toEqual([]);
		expect(requestExit).not.toHaveBeenCalled();
	});

	it("refuses outside a container, even with --force", async () => {
		const { api, requestExit } = harness({ isInContainer: () => false });
		const response = await api.update({ kind: "user" }, request({ force: true }));
		expect(response.status).toBe("refused");
		expect(response.message).toContain("doesn't run in a container here (no /run/.containerenv)");
		expect(requestExit).not.toHaveBeenCalled();
	});

	it("refuses without a newer image, with an unstamped build or an unreachable registry, unless --force", async () => {
		const current = harness({ fetchLatestBuild: async () => ({ ...OLD, digest: "sha256:old" }) });
		expect((await current.api.update({ kind: "user" }, request())).message).toContain(
			"Already on the latest image (aaaaaaa (built 2026-10-11 06:20Z))",
		);
		const unstamped = harness({ readRunningBuild: () => null });
		expect((await unstamped.api.update({ kind: "user" }, request())).message).toContain("has no build stamp");
		const down = harness({
			fetchLatestBuild: async () => {
				throw new Error("HTTP 503");
			},
		});
		expect((await down.api.update({ kind: "user" }, request())).message).toContain(
			"Could not read ghcr.io/vombor/kanban:latest from the registry (HTTP 503)",
		);
		const forced = await down.api.update({ kind: "user" }, request({ force: true }));
		expect(forced.status).toBe("restarting");
		expect(forced.lines).toContain("could not read ghcr.io/vombor/kanban:latest (HTTP 503); --force restarts anyway");
	});

	it("refuses while a card is In Progress; --force restarts and says what happens to it", async () => {
		const blocked = harness({ inProgress: ["c1", "c2"] });
		const response = await blocked.api.update(session(KANBAN, "orchestrator"), request());
		expect(response.status).toBe("refused");
		expect(response.message).toContain("Cards are In Progress (foo/c1, foo/c2)");
		expect(blocked.logEntries[0]?.inProgress).toEqual(["foo/c1", "foo/c2"]);
		expect(blocked.prepared).toEqual([]);

		const forced = await blocked.api.update(session(KANBAN, "orchestrator"), request({ force: true }));
		expect(forced.status).toBe("restarting");
		expect(forced.lines).toContain(
			"In Progress in foo: c1, c2 (stops with the container; restart recovery resumes it)",
		);
	});

	it("runs restart prepare with the update in every workspace, answers, then exits with 75", async () => {
		vi.useFakeTimers();
		const { api, prepared, requestExit, logEntries, warn } = harness();
		const response = await api.update(session(KANBAN, "orchestrator"), request());
		expect(response.status).toBe("restarting");
		expect(response.message).toContain(
			"Restarting the container from aaaaaaa (built 2026-10-11 06:20Z) to bbbbbbb (built 2026-10-12 06:20Z), sha256:new",
		);
		expect(response.lines).toContain("kanban-2uge: wrote the manifest");
		expect(prepared.map((input) => [input.target.workspaceId, input.dryRun, input.update])).toEqual([
			[KANBAN, false, { from: OLD, to: NEW }],
			["foo", false, { from: OLD, to: NEW }],
		]);
		expect(logEntries).toEqual([
			expect.objectContaining({
				status: "restarting",
				caller: "the orchestrator of kanban-2uge",
				from: OLD,
				to: NEW,
			}),
		]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("[kanban] restart update (the orchestrator of"));
		// The answer goes out first; the shutdown starts after the delay.
		expect(requestExit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(50);
		expect(requestExit).toHaveBeenCalledWith(KANBAN_UPDATE_RESTART_EXIT_CODE);
		expect(KANBAN_UPDATE_RESTART_EXIT_CODE).toBe(75);
		// A second request while it restarts is refused.
		expect((await api.update({ kind: "user" }, request({ force: true }))).message).toContain("already under way");
	});

	it("a dry run checks and prepares in dry-run mode, and stops nothing", async () => {
		vi.useFakeTimers();
		const { api, prepared, requestExit } = harness();
		const response = await api.update({ kind: "user" }, request({ dryRun: true }));
		expect(response.status).toBe("dry_run");
		expect(prepared.every((input) => input.dryRun)).toBe(true);
		vi.advanceTimersByTime(5_000);
		expect(requestExit).not.toHaveBeenCalled();
	});
});
