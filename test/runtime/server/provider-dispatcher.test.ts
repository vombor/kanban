import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionStartResponse } from "../../../src/core/api-contract";
import {
	createProviderDispatcher,
	type ProviderActivity,
	type ProviderStartIntent,
} from "../../../src/server/provider-dispatcher";
import { createTempDir } from "../../utilities/temp-dir";

describe("machine-wide provider dispatcher (#53)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});
	function setup() {
		const temp = createTempDir("dispatch-");
		cleanups.push(temp.cleanup);
		let now = 1000,
			until: number | null = null;
		const active: ProviderActivity[] = [];
		const launch = vi.fn(async (intent: ProviderStartIntent): Promise<RuntimeTaskSessionStartResponse> => {
			active.push({
				key: `${intent.workspaceId}\0${intent.taskId}`,
				resources: [`provider:${intent.body.agentSettings?.providerId}`],
			});
			return { ok: true, summary: null };
		});
		const finished = vi.fn(async () => undefined);
		const invalid = new Set<string>();
		const deps = {
			workspaceIds: async () => ["foo", "bar"],
			queuePath: (id: string) => join(temp.path, `${id}.json`),
			lockPath: join(temp.path, "lock"),
			limits: async () => ({ "provider:cline-pass": 1 }),
			activity: async () => active,
			admission: async (intent: ProviderStartIntent) => ({
				provider: intent.body.agentSettings?.providerId ?? null,
				resources: [`provider:${intent.body.agentSettings?.providerId}`],
				until: intent.body.agentSettings?.providerId === "cline-pass" ? until : null,
			}),
			valid: async (intent: ProviderStartIntent) => !invalid.has(intent.taskId),
			execute: launch,
			finished,
			queued: vi.fn(async () => undefined),
			now: () => now,
			log: vi.fn(),
		};
		const dispatcher = createProviderDispatcher(deps);
		cleanups.push(dispatcher.close);
		const intent = (id: string, workspaceId = "foo", provider = "cline-pass"): ProviderStartIntent => ({
			taskId: id,
			workspaceId,
			body: {
				taskId: id,
				prompt: "approved task",
				baseRef: "main",
				agentId: "cline",
				agentSettings: { providerId: provider },
			},
			fingerprint: "current",
			explicit: false,
			at: ++now,
		});
		return {
			temp,
			deps,
			dispatcher,
			active,
			launch,
			finished,
			invalid,
			intent,
			hold: (value: number | null) => {
				until = value;
			},
			advance: (value: number) => {
				now = value;
			},
		};
	}
	it("serializes simultaneous starts across projects, deduplicates queued requests and leaves other providers free", async () => {
		const test = setup();
		const a = test.intent("a"),
			b = test.intent("b", "bar");
		const results = await Promise.all([test.dispatcher.submit(a), test.dispatcher.submit(b)]);
		expect(results.filter((result) => result.queued)).toHaveLength(1);
		expect(test.launch).toHaveBeenCalledTimes(1);
		const pending = (await test.dispatcher.pending())[0];
		if (!pending) throw new Error("Missing queued competitor");
		expect(["a", "b"]).toContain(pending.taskId);
		await test.dispatcher.submit(pending);
		expect(await test.dispatcher.pending()).toHaveLength(1);
		await test.dispatcher.submit(test.intent("local", "bar", "lemonade"));
		expect(test.launch).toHaveBeenCalledTimes(2);
		test.active.splice(0);
		await test.dispatcher.flush();
		expect(test.launch.mock.calls.at(-1)?.[0].taskId).toBe(pending.taskId);
		expect(await test.dispatcher.pending()).toEqual([]);
	});
	it("hydrates private intents after restart and queues due quota retries one at a time", async () => {
		const test = setup();
		test.hold(10_000);
		await test.dispatcher.submit(test.intent("retry1"));
		await test.dispatcher.submit(test.intent("retry2", "bar"));
		expect(test.launch).not.toHaveBeenCalled();
		expect(statSync(test.deps.queuePath("foo")).mode & 0o777).toBe(0o600);
		test.dispatcher.close();
		const restarted = createProviderDispatcher(test.deps);
		cleanups.push(restarted.close);
		await restarted.flush();
		expect(test.launch).not.toHaveBeenCalled();
		test.advance(10_001);
		await restarted.flush();
		expect(test.launch).toHaveBeenCalledTimes(1);
		expect((await restarted.pending()).map((intent) => intent.taskId)).toEqual(["retry2"]);
		test.active.splice(0);
		await restarted.flush();
		expect(test.launch).toHaveBeenCalledTimes(2);
	});
	it("does not let an objective-held earlier intent block unrelated eligible work on the same provider", async () => {
		const test = setup(),
			original = test.deps.admission;
		test.deps.admission = async (intent) => ({
			...(await original(intent)),
			until: intent.taskId === "paused" ? Number.MAX_SAFE_INTEGER : null,
		});
		expect((await test.dispatcher.submit(test.intent("paused"))).queued).toBe(true);
		expect((await test.dispatcher.submit(test.intent("eligible", "bar"))).queued).not.toBe(true);
		expect(test.launch).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ taskId: "eligible" }),
			expect.any(AbortSignal),
		);
		expect((await test.dispatcher.pending()).map((row) => row.taskId)).toEqual(["paused"]);
	});
	it("drops changed/Done intents and cancels exactly the requested queue without launching", async () => {
		const test = setup();
		test.hold(10_000);
		await test.dispatcher.submit(test.intent("changed"));
		await test.dispatcher.submit(test.intent("cancel", "bar"));
		test.invalid.add("changed");
		await test.dispatcher.cancel("bar", "cancel");
		test.hold(null);
		await test.dispatcher.flush();
		expect(test.launch).not.toHaveBeenCalled();
		expect(await test.dispatcher.pending()).toEqual([]);
	});
	it("refuses corrupted queues without overwriting original evidence", async () => {
		const test = setup();
		writeFileSync(test.deps.queuePath("foo"), "{truncated");
		await expect(test.dispatcher.submit(test.intent("a"))).rejects.toThrow("unreadable");
		expect(readFileSync(test.deps.queuePath("foo"), "utf8")).toBe("{truncated");
		expect(test.launch).not.toHaveBeenCalled();
	});
	it("reserves input against the same slot pool and releases failures without blocking another provider", async () => {
		const test = setup();
		const admission = { resources: ["provider:cline-pass"], provider: "cline-pass", until: null };
		expect(await test.dispatcher.reserveInput("foo", "a", admission)).toBe(true);
		expect(await test.dispatcher.reserveInput("bar", "b", admission)).toBe(false);
		const result = await test.dispatcher.submit(test.intent("b", "bar"));
		expect(result.queued).toBe(true);
		test.dispatcher.releaseInput("foo", "a");
		await test.dispatcher.flush();
		expect(test.launch).toHaveBeenCalledOnce();
	});
	it("keeps a launch intent when shutdown interrupts admission so restart can reconcile it", async () => {
		const test = setup();
		let finish: ((response: RuntimeTaskSessionStartResponse) => void) | undefined;
		test.launch.mockImplementationOnce(
			async () =>
				await new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const starting = test.dispatcher.submit(test.intent("a"));
		await vi.waitFor(() => expect(finish).toBeDefined());
		test.dispatcher.close();
		finish?.({ ok: false, summary: null });
		await starting;
		expect((await test.dispatcher.pending()).map((intent) => intent.taskId)).toEqual(["a"]);
	});
});
