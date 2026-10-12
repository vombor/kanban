import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	ORCHESTRATOR_NOTICES_TIMEOUT_MS,
	runOrchestratorNoticesHook,
} from "../../../src/commands/hook-events/orchestrator-notices-hook";
import type { RuntimeTaskInputDeliveryResponse } from "../../../src/core/api-contract";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createOrchestratorInbox } from "../../../src/server/orchestrator-inbox";
import { createWatchdogActionHandler } from "../../../src/server/watchdog-actions";
import { createOrchestratorInboxApi, refuseOrchestratorInboxCaller } from "../../../src/trpc/orchestrator-inbox-api";
import { createTempDir } from "../../utilities/temp-dir";

const MIN = 60_000;
const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const FOO_SIDEBAR = "__home_agent__:foo:claude";
const BAR_SIDEBAR = "__home_agent__:bar:claude";

const temps: Array<{ cleanup: () => void }> = [];
afterEach(() => {
	for (const temp of temps.splice(0)) {
		temp.cleanup();
	}
});

function delivery(status: RuntimeTaskInputDeliveryResponse["status"]): RuntimeTaskInputDeliveryResponse {
	return { ok: status !== "no_session", status, evidence: null, enterAttempts: 0, summary: null };
}

function setup(options: { live?: boolean; deliverStatus?: RuntimeTaskInputDeliveryResponse["status"] } = {}) {
	const temp = createTempDir("kanban-orchestrator-inbox-");
	temps.push(temp);
	let now = NOW;
	let live = options.live ?? true;
	const typed: Array<{ workspaceId: string; taskId: string; text: string }> = [];
	const log = vi.fn((_message: string) => {});
	const getPath = (workspaceId: string) => join(temp.path, "data", workspaceId, "orchestrator-inbox.jsonl");
	const inbox = createOrchestratorInbox({
		getTerminal: () => ({ hasLiveProcess: () => live }),
		hold: {
			deliver: async (workspaceId, taskId, text) => {
				typed.push({ workspaceId, taskId, text });
				return delivery(options.deliverStatus ?? "delivered");
			},
		},
		listWorkspaceIds: () => ["foo", "bar"],
		log,
		now: () => now,
		getPath,
	});
	const queue = async (workspaceId: string, text: string, typeAfterMin = 30) =>
		await inbox.queue({
			workspaceId,
			taskId: `__home_agent__:${workspaceId}:claude`,
			items: [`- ${text}`],
			text: `[kanban watchdog] ${text}`,
			typeAfter: now + typeAfterMin * MIN,
		});
	return {
		inbox,
		typed,
		log,
		getPath,
		queue,
		setNow: (next: number) => {
			now = next;
		},
		setLive: (next: boolean) => {
			live = next;
		},
	};
}

describe("orchestrator inbox (silent wakes)", () => {
	it("queues per workspace and hands each workspace only its own notices", async () => {
		const harness = setup();
		expect(await harness.queue("foo", "d0001 stalled")).toEqual({ ok: true, pending: 1 });
		expect(await harness.queue("foo", "d0002 stalled")).toEqual({ ok: true, pending: 2 });
		await harness.queue("bar", "b0001 stalled");
		// A line tagged with another workspace in foo's file is never handed out.
		const fooPath = harness.getPath("foo");
		writeFileSync(
			fooPath,
			`${readFileSync(fooPath, "utf8")}${JSON.stringify({
				workspaceId: "bar",
				taskId: BAR_SIDEBAR,
				at: "x",
				typeAfter: "x",
				items: [],
				text: "bar's leak",
			})}\nnot json\n`,
		);
		expect(await harness.inbox.status("foo")).toEqual({ pending: 2, oldestAt: new Date(NOW).toISOString() });

		const foo = await harness.inbox.take("foo");
		expect(foo.map((entry) => entry.text)).toEqual([
			"[kanban watchdog] d0001 stalled",
			"[kanban watchdog] d0002 stalled",
		]);
		expect(existsSync(fooPath)).toBe(false);
		expect(await harness.inbox.take("foo")).toEqual([]);
		expect((await harness.inbox.take("bar")).map((entry) => entry.text)).toEqual(["[kanban watchdog] b0001 stalled"]);
	});

	it("refuses another workspace's sidebar session", async () => {
		const harness = setup();
		const result = await harness.inbox.queue({
			workspaceId: "foo",
			taskId: BAR_SIDEBAR,
			items: [],
			text: "x",
			typeAfter: NOW,
		});
		expect(result.ok).toBe(false);
		expect(existsSync(harness.getPath("foo"))).toBe(false);
	});

	it("types unread notices once they are due, through the typed-input hold, and not before", async () => {
		const harness = setup();
		await harness.queue("foo", "first", 30);
		await harness.queue("foo", "second", 40);
		harness.setNow(NOW + 29 * MIN);
		expect(await harness.inbox.flushOverdue()).toBe(0);
		expect(harness.typed).toEqual([]);

		harness.setNow(NOW + 30 * MIN);
		expect(await harness.inbox.flushOverdue()).toBe(1);
		expect(harness.typed).toEqual([{ workspaceId: "foo", taskId: FOO_SIDEBAR, text: "[kanban watchdog] first" }]);
		expect((await harness.inbox.status("foo")).pending).toBe(1);
	});

	it("keeps due notices while the sidebar has no process, and drops them after the hold time", async () => {
		const harness = setup({ live: false });
		await harness.queue("foo", "first", 30);
		harness.setNow(NOW + 31 * MIN);
		expect(await harness.inbox.flushOverdue()).toBe(0);
		expect((await harness.inbox.status("foo")).pending).toBe(1);

		harness.setNow(NOW + 30 * MIN + 60 * MIN);
		await harness.inbox.flushOverdue();
		expect(harness.typed).toEqual([]);
		expect(existsSync(harness.getPath("foo"))).toBe(false);
		expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("dropped 1 unread notice(s)"));
	});

	it("puts notices back when typing them reached nothing", async () => {
		const harness = setup({ deliverStatus: "no_session" });
		await harness.queue("foo", "first", 0);
		expect(await harness.inbox.flushOverdue()).toBe(0);
		expect(harness.typed).toHaveLength(1);
		expect((await harness.inbox.status("foo")).pending).toBe(1);
	});
});

describe("orchestratorInbox.take", () => {
	const orchestrator = (workspaceId: string): RuntimeCaller => ({
		kind: "session",
		via: "credential",
		session: {
			workspaceId,
			taskId: `__home_agent__:${workspaceId}:claude`,
			role: "orchestrator",
			agentId: "claude",
			cwd: `/projects/${workspaceId}`,
		},
	});

	it("gives the notices only to the workspace's own orchestrator or the user", () => {
		expect(refuseOrchestratorInboxCaller({ kind: "user" }, "foo")).toBeNull();
		expect(refuseOrchestratorInboxCaller(orchestrator("foo"), "foo")).toBeNull();
		expect(refuseOrchestratorInboxCaller(orchestrator("bar"), "foo")).toContain("only by its own orchestrator");
		expect(
			refuseOrchestratorInboxCaller(
				{
					kind: "session",
					via: "process",
					session: { workspaceId: "foo", taskId: "a1b2c", role: "card", agentId: "claude", cwd: "/wt/a1b2c" },
				},
				"foo",
			),
		).not.toBeNull();
		expect(refuseOrchestratorInboxCaller({ kind: "unknown", reason: "no session" }, "foo")).not.toBeNull();
	});

	it("frames the notices for the prompt and leaves a refused caller's notices queued", async () => {
		const harness = setup();
		await harness.queue("foo", "d0001 stalled");
		const api = createOrchestratorInboxApi({ inbox: harness.inbox, log: () => {} });

		const refused = await api.take({ caller: orchestrator("bar"), workspaceId: "foo" });
		expect(refused).toMatchObject({ ok: false, notices: null, count: 0 });
		expect((await harness.inbox.status("foo")).pending).toBe(1);

		const taken = await api.take({ caller: orchestrator("foo"), workspaceId: "foo" });
		expect(taken.count).toBe(1);
		expect(taken.notices).toMatch(/^Kanban notices since your last turn/u);
		expect(taken.notices).toContain("- [kanban watchdog] d0001 stalled");
		expect(await api.take({ caller: orchestrator("foo"), workspaceId: "foo" })).toMatchObject({
			ok: true,
			notices: null,
			count: 0,
		});
	});
});

describe("watchdog queueOrchestratorNotices request", () => {
	it("is refused across workspaces and for a session that isn't the workspace's sidebar", async () => {
		const harness = setup();
		const handle = createWatchdogActionHandler({
			getWorkspacePathById: (workspaceId) => `/projects/${workspaceId}`,
			getTerminal: async () => {
				throw new Error("no terminal");
			},
			startTaskSession: async () => ({ ok: true, summary: null }),
			runProcessSweep: async () => ({ supported: false, lastSweep: null }),
			onBoardMutated: async () => {},
			orchestratorInbox: harness.inbox,
		});
		const request = {
			kind: "queueOrchestratorNotices" as const,
			workspaceId: "foo",
			taskId: FOO_SIDEBAR,
			items: ["- x"],
			text: "x",
			typeAfter: NOW,
			fromWorkspaceId: "foo",
		};
		expect(await handle({ ...request, fromWorkspaceId: "bar" })).toMatchObject({ ok: false });
		expect(await handle({ ...request, taskId: BAR_SIDEBAR })).toMatchObject({ ok: false });
		expect(await handle({ ...request, taskId: "a1b2c" })).toMatchObject({ ok: false });
		expect(existsSync(harness.getPath("foo"))).toBe(false);
		expect(await handle(request)).toEqual({ ok: true, pending: 1 });
	});
});

describe("kanban hooks orchestrator-notices", () => {
	const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi", cwd: "/projects/foo" });

	it("prints the notices as UserPromptSubmit additionalContext", async () => {
		const written: string[] = [];
		const take = vi.fn(async () => ({ notices: "Kanban notices since your last turn:\n- x" }));
		await runOrchestratorNoticesHook({ workspaceId: "foo", payload, take, write: (text) => written.push(text) });
		expect(take).toHaveBeenCalledWith("foo");
		expect(written).toHaveLength(1);
		expect(JSON.parse(written[0] ?? "")).toEqual({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "Kanban notices since your last turn:\n- x",
			},
		});
	});

	it("prints nothing and never throws when there is nothing, the server fails or it is too slow", async () => {
		const written: string[] = [];
		const write = (text: string) => written.push(text);
		await runOrchestratorNoticesHook({ workspaceId: "foo", payload, take: async () => ({ notices: null }), write });
		await expect(
			runOrchestratorNoticesHook({
				workspaceId: "foo",
				payload: "not json",
				take: async () => {
					throw new Error("ECONNREFUSED");
				},
				write,
			}),
		).resolves.toBeUndefined();
		await runOrchestratorNoticesHook({
			workspaceId: "foo",
			payload,
			take: () => new Promise(() => {}),
			write,
			timeoutMs: 5,
		});
		expect(written).toEqual([]);
		expect(ORCHESTRATOR_NOTICES_TIMEOUT_MS).toBeLessThan(15_000);
	});

	it("takes nothing for another hook event or without a workspace", async () => {
		const take = vi.fn(async () => ({ notices: "x" }));
		await runOrchestratorNoticesHook({
			workspaceId: "foo",
			payload: JSON.stringify({ hook_event_name: "Stop" }),
			take,
			write: () => {},
		});
		await runOrchestratorNoticesHook({ workspaceId: " ", payload, take, write: () => {} });
		expect(take).not.toHaveBeenCalled();
	});
});
