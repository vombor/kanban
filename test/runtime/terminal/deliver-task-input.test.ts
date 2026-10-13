import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	type DeliverTaskInputResult,
	deliverTaskInput,
	describeTypedInputState,
	flattenTaskInputText,
	type TaskInputTerminal,
} from "../../../src/terminal/deliver-task-input";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/repo/task-1",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 100,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: 100,
		latestHookActivity: null,
		modelId: null,
		reasoningEffort: null,
		...overrides,
	};
}

interface FakeTerminalOptions {
	agentId?: RuntimeAgentId | null;
	/** No summary at all: the task never had a session. */
	missing?: boolean;
	/** A summary exists (hydrated after a restart) but there is no live PTY. */
	inactive?: boolean;
	/** The user has a draft in the terminal (TerminalSessionManager.hasTypedInputSinceEnter). */
	userTyping?: boolean;
	/** What the agent does when it receives Enter number `n` (1-based). */
	onEnter?: (n: number, terminal: FakeTerminal) => void;
}

interface FakeTerminal extends TaskInputTerminal {
	writes: string[];
	summary: RuntimeTaskSessionSummary;
	patch(patch: Partial<RuntimeTaskSessionSummary>): void;
	end(): void;
}

function createFakeTerminal(options: FakeTerminalOptions = {}): FakeTerminal {
	let enters = 0;
	let active = !options.inactive;
	const terminal: FakeTerminal = {
		writes: [],
		summary: createSummary({ agentId: options.agentId === undefined ? "claude" : options.agentId }),
		patch(patch) {
			terminal.summary = { ...terminal.summary, ...patch };
		},
		end() {
			active = false;
			terminal.patch({ state: "awaiting_review", reviewReason: "exit", pid: null, exitCode: 0 });
		},
		getSummary: vi.fn(() => (options.missing ? null : { ...terminal.summary })),
		hasTypedInputSinceEnter: vi.fn(() => options.userTyping ?? false),
		writeInput: vi.fn((_taskId: string, data: Buffer) => {
			if (options.missing || !active) {
				return null;
			}
			const text = data.toString("utf8");
			terminal.writes.push(text);
			if (text === "\r") {
				enters += 1;
				options.onEnter?.(enters, terminal);
			} else {
				// The TUI echoes typed text; that alone must not count as delivery.
				terminal.patch({ lastOutputAt: (terminal.summary.lastOutputAt ?? 0) + 1 });
			}
			return { ...terminal.summary };
		}),
	};
	return terminal;
}

async function runDelivery(promise: Promise<DeliverTaskInputResult>): Promise<DeliverTaskInputResult> {
	await vi.runAllTimersAsync();
	return await promise;
}

describe("deliverTaskInput", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("confirms delivery when the session shows activity after Enter", async () => {
		const terminal = createFakeTerminal({
			onEnter: (_n, t) => t.patch({ state: "running", reviewReason: null, lastHookAt: 200 }),
		});

		const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "Commit the\n  work onto main."));

		expect(delivery).toMatchObject({ ok: true, status: "delivered", evidence: "state", enterAttempts: 1 });
		expect(delivery.summary?.state).toBe("running");
		// Newlines are flattened and Enter is its own write.
		expect(terminal.writes).toEqual(["Commit the work onto main.", "\r"]);
	});

	it("reports hook and output activity as evidence when the state does not change", async () => {
		const hookTerminal = createFakeTerminal({ onEnter: (_n, t) => t.patch({ lastHookAt: 300 }) });
		// An agent without a prompt-submit hook: its new output is the only sign it took the input.
		const outputTerminal = createFakeTerminal({
			agentId: "cline",
			onEnter: (_n, t) => t.patch({ lastOutputAt: 999 }),
		});

		const viaHook = await runDelivery(deliverTaskInput(hookTerminal, "task-1", "go"));
		const viaOutput = await runDelivery(deliverTaskInput(outputTerminal, "task-1", "go"));

		expect(viaHook).toMatchObject({ status: "delivered", evidence: "hook" });
		expect(viaOutput).toMatchObject({ status: "delivered", evidence: "output" });
	});

	it("presses Enter a second time when the first one shows no activity", async () => {
		const terminal = createFakeTerminal({
			agentId: "cline",
			onEnter: (n, t) => {
				if (n === 2) {
					t.patch({ lastOutputAt: 500 });
				}
			},
		});

		const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "go"));

		expect(delivery).toMatchObject({ ok: true, status: "delivered", evidence: "output", enterAttempts: 2 });
		expect(terminal.writes).toEqual(["go", "\r", "\r"]);
	});

	it("reports undelivered when neither Enter is picked up", async () => {
		const terminal = createFakeTerminal();

		const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "go"));

		expect(delivery).toMatchObject({ ok: false, status: "undelivered", evidence: null, enterAttempts: 2 });
		expect(delivery.error).toMatch(/not picked up/);
		// The echo of the typed text happened before Enter and did not count.
		expect(terminal.writes).toEqual(["go", "\r", "\r"]);
	});

	it("refuses with user_typing and writes nothing while the user is typing in the terminal (issue #35)", async () => {
		// Codex too: the stricter delivery proof of issue #52 never types or presses Enter into a draft.
		for (const agentId of ["claude", "codex"] as const) {
			const terminal = createFakeTerminal({ agentId, userTyping: true });

			const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "go"));

			expect(delivery).toMatchObject({ ok: false, status: "user_typing", enterAttempts: 0 });
			expect(terminal.writeInput).not.toHaveBeenCalled();
		}
	});

	describe("an idle agent whose prompt hook fires on submit (issue #52)", () => {
		it("doesn't take a repaint for delivery: presses Enter again until the prompt hook shows", async () => {
			// cline-pass-test's Codex sidebar, 2026-10-13 20:10Z: the wake sat in the composer, reported delivered.
			const terminal = createFakeTerminal({
				agentId: "codex",
				onEnter: (n, t) =>
					n === 1
						? t.patch({ lastOutputAt: 500 })
						: t.patch({ state: "running", reviewReason: null, lastHookAt: 600, lastOutputAt: 601 }),
			});

			const delivery = await runDelivery(
				deliverTaskInput(terminal, "task-1", "30b1e: dev card ran but changed nothing"),
			);

			expect(delivery).toMatchObject({ ok: true, status: "delivered", evidence: "state", enterAttempts: 2 });
			expect(terminal.writes).toEqual(["30b1e: dev card ran but changed nothing", "\r", "\r"]);
		});

		it("reports undelivered when both Enters only repaint the TUI", async () => {
			const terminal = createFakeTerminal({
				agentId: "codex",
				onEnter: (n, t) => t.patch({ lastOutputAt: 500 + n }),
			});

			const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "go"));

			expect(delivery).toMatchObject({ ok: false, status: "undelivered", evidence: null, enterAttempts: 2 });
			expect(delivery.error).toMatch(/no prompt hook or state change/);
		});

		it("counts the prompt hook alone for Claude Code too", async () => {
			const terminal = createFakeTerminal({ onEnter: (_n, t) => t.patch({ lastHookAt: 300, lastOutputAt: 301 }) });

			expect(await runDelivery(deliverTaskInput(terminal, "task-1", "go"))).toMatchObject({
				status: "delivered",
				evidence: "hook",
				enterAttempts: 1,
			});
		});

		it("still takes output while the agent is running, or before its session ever reported a hook", async () => {
			const running = createFakeTerminal({ agentId: "codex", onEnter: (_n, t) => t.patch({ lastOutputAt: 999 }) });
			running.patch({ state: "running", reviewReason: null });
			const noHooks = createFakeTerminal({ agentId: "codex", onEnter: (_n, t) => t.patch({ lastOutputAt: 999 }) });
			noHooks.patch({ lastHookAt: null });

			for (const terminal of [running, noHooks]) {
				expect(await runDelivery(deliverTaskInput(terminal, "task-1", "go"))).toMatchObject({
					status: "delivered",
					evidence: "output",
					enterAttempts: 1,
				});
			}
		});
	});

	it("says why the user counts as typing: a draft since when, or a recent keystroke (issue #39)", async () => {
		const terminal = createFakeTerminal({ userTyping: true });
		const typing = {
			draftSince: Date.parse("2026-10-12T03:54:02Z"),
			draftTypedAt: Date.parse("2026-10-12T03:54:02Z"),
			viewerTypedAt: Date.parse("2026-10-12T03:54:02Z"),
		};
		const withReason = { ...terminal, describeTypedInput: vi.fn(() => typing) };

		const delivery = await runDelivery(deliverTaskInput(withReason, "task-1", "go"));

		expect(delivery).toMatchObject({ status: "user_typing", typing });
		expect(delivery.error).toContain("a draft in the input box since 2026-10-12T03:54:02.000Z");
		expect(terminal.writeInput).not.toHaveBeenCalled();
		const now = Date.parse("2026-10-12T05:39:02Z");
		expect(describeTypedInputState(typing, now)).toBe(
			"a draft in the input box since 2026-10-12T03:54:02.000Z (text last typed 1 h 45 min ago)",
		);
		expect(describeTypedInputState({ draftSince: null, draftTypedAt: null, viewerTypedAt: now - 3_000 }, now)).toBe(
			"a keystroke 3 s ago",
		);
	});

	it("reports no_session and writes nothing when the task has no session", async () => {
		const terminal = createFakeTerminal({ missing: true });

		const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "go"));

		expect(delivery).toMatchObject({ ok: false, status: "no_session", enterAttempts: 0, summary: null });
		expect(terminal.writeInput).not.toHaveBeenCalled();
	});

	it("reports no_session when only a stale summary is left (no live PTY)", async () => {
		const terminal = createFakeTerminal({ inactive: true });

		const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "go"));

		expect(delivery).toMatchObject({ ok: false, status: "no_session", enterAttempts: 0 });
		expect(terminal.writes).toEqual([]);
	});

	it("reports session_ended when the agent exits while delivery waits", async () => {
		const terminal = createFakeTerminal({ onEnter: (_n, t) => t.end() });

		const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "go"));

		expect(delivery).toMatchObject({ ok: false, status: "session_ended", enterAttempts: 1 });
	});

	it("sends a focus-in escape first for agents whose TUI needs focus (Copilot)", async () => {
		const terminal = createFakeTerminal({
			agentId: "copilot",
			onEnter: (_n, t) => t.patch({ lastHookAt: 300 }),
		});

		const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "go"));

		expect(delivery.status).toBe("delivered");
		expect(terminal.writes).toEqual(["\u001b[I", "go", "\r"]);
	});

	it("uses the fallback agent for the input profile only when the session records none", async () => {
		const unrecorded = createFakeTerminal({ agentId: null, onEnter: (_n, t) => t.patch({ lastHookAt: 300 }) });
		const recorded = createFakeTerminal({ agentId: "claude", onEnter: (_n, t) => t.patch({ lastHookAt: 300 }) });

		await runDelivery(deliverTaskInput(unrecorded, "task-1", "go", { agentId: "copilot" }));
		await runDelivery(deliverTaskInput(recorded, "task-1", "go", { agentId: "copilot" }));

		expect(unrecorded.writes[0]).toBe("\u001b[I");
		expect(recorded.writes[0]).toBe("go");
	});

	it("only types the text when enter is false", async () => {
		const terminal = createFakeTerminal();

		const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "partial", { enter: false }));

		expect(delivery).toMatchObject({ ok: true, status: "sent", enterAttempts: 0 });
		expect(terminal.writes).toEqual(["partial"]);
	});

	it("presses Enter once without waiting when confirm is false", async () => {
		const terminal = createFakeTerminal();

		const delivery = await runDelivery(deliverTaskInput(terminal, "task-1", "go", { confirm: false }));

		expect(delivery).toMatchObject({ ok: true, status: "sent", enterAttempts: 1 });
		expect(terminal.writes).toEqual(["go", "\r"]);
	});

	it("stops waiting when the caller aborts", async () => {
		const terminal = createFakeTerminal();
		const abort = new AbortController();

		const promise = deliverTaskInput(terminal, "task-1", "go", { signal: abort.signal });
		await vi.advanceTimersByTimeAsync(1_000);
		abort.abort();
		const delivery = await promise;

		expect(delivery).toMatchObject({ ok: false, status: "aborted", enterAttempts: 1 });
		expect(terminal.writes).toEqual(["go", "\r"]);
	});
});

describe("flattenTaskInputText", () => {
	it("joins lines with single spaces", () => {
		expect(flattenTaskInputText("one\r\n  two\n\nthree")).toBe("one two three");
	});
});
