import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	appendOrchestratorQueue,
	filterStillOpen,
	readLiveLockPid,
	runOrchestratorHeadless,
} from "../../../../src/pipeline/watchdog/headless-run";
import { getOrchestratorLockPath, getWatchdogWorkspacePaths } from "../../../../src/state/kanban-home";
import type { HeadlessOrchestratorCommand } from "../../../../src/terminal/orchestrator-agents";
import { withTemporaryKanbanHome } from "../../../utilities/kanban-home";

const NOW = new Date("2026-10-07T12:00:00.000Z");

/** A fake agent process that exits on the next tick; `onRun` sees each run's command (and may queue more issues). */
function fakeSpawn(onRun: (command: HeadlessOrchestratorCommand) => void) {
	return vi.fn((command: HeadlessOrchestratorCommand) => {
		const child = new EventEmitter() as ChildProcess;
		child.kill = vi.fn(() => true);
		onRun(command);
		setImmediate(() => child.emit("exit", 0));
		return child;
	});
}

describe("headless orchestrator run", () => {
	it("runs the selected agent's headless command on the queue, handles follow-ups, and drops issues no longer in ATTENTION", async () => {
		await withTemporaryKanbanHome(async () => {
			const paths = getWatchdogWorkspacePaths("foo");
			await appendOrchestratorQueue(paths.orchestratorQueue, "foo", ["- **a0001** (review): escalated"], NOW);
			mkdirSync(dirname(paths.attention), { recursive: true });
			writeFileSync(paths.attention, "- **b0001** (review): still open\n");
			const prompts: string[] = [];
			let runs = 0;
			const spawnAgent = fakeSpawn((command) => {
				prompts.push(command.args[1] ?? "");
				expect(command.binary).toBe("claude");
				expect(existsSync(getOrchestratorLockPath("foo"))).toBe(true);
				runs += 1;
				if (runs === 1) {
					// Reported while the first run works: one still in ATTENTION, one already cleared.
					writeFileSync(
						paths.orchestratorQueue,
						`${NOW.toISOString()} [foo] b0001: still open\n${NOW.toISOString()} [foo] c0001: gone\n`,
					);
				}
			});
			const result = await runOrchestratorHeadless(
				{ workspaceId: "foo", projectPath: "/projects/foo", agentId: "claude", timeoutMin: 1, liveSessionMin: 10 },
				{ spawnAgent, findLiveSession: async () => null, now: () => NOW },
			);
			expect(result).toEqual({ runs: 2, skipped: null });
			expect(prompts[0]).toContain("[foo] a0001 (review): escalated");
			expect(prompts[0]).toContain("started headless by Kanban's watchdog");
			expect(prompts[1]).toContain("b0001: still open");
			expect(prompts[1]).not.toContain("c0001");
			expect(existsSync(getOrchestratorLockPath("foo"))).toBe(false);
		});
	});

	it("never starts beside a live interactive session or another run; the queue stays", async () => {
		await withTemporaryKanbanHome(async () => {
			const paths = getWatchdogWorkspacePaths("foo");
			await appendOrchestratorQueue(paths.orchestratorQueue, "foo", ["- a0001: x"], NOW);
			const spawnAgent = fakeSpawn(() => {});
			const live = await runOrchestratorHeadless(
				{ workspaceId: "foo", projectPath: "/projects/foo", agentId: "claude", timeoutMin: 1, liveSessionMin: 10 },
				{ spawnAgent, findLiveSession: async () => ({ id: "abcd1234", ageSec: 30 }), now: () => NOW },
			);
			expect(live).toEqual({ runs: 0, skipped: "interactive session abcd1234" });

			mkdirSync(dirname(getOrchestratorLockPath("foo")), { recursive: true });
			writeFileSync(getOrchestratorLockPath("foo"), String(process.pid));
			const held = await runOrchestratorHeadless(
				{ workspaceId: "foo", projectPath: "/projects/foo", agentId: "claude", timeoutMin: 1, liveSessionMin: 10 },
				{ spawnAgent, findLiveSession: async () => null, pid: process.pid + 1, now: () => NOW },
			);
			expect(held.skipped).toBe(`run ${process.pid} active`);
			expect(spawnAgent).not.toHaveBeenCalled();
			expect(readFileSync(paths.orchestratorQueue, "utf8")).toContain("a0001: x");
		});
	});

	it("an agent without a headless runner never runs headless", async () => {
		await withTemporaryKanbanHome(async () => {
			const spawnAgent = fakeSpawn(() => {});
			const result = await runOrchestratorHeadless(
				{ workspaceId: "foo", projectPath: "/projects/foo", agentId: "cline", timeoutMin: 1, liveSessionMin: 10 },
				{ spawnAgent, findLiveSession: async () => null, now: () => NOW },
			);
			expect(result.skipped).toBe("no headless runner");
			expect(spawnAgent).not.toHaveBeenCalled();
		});
	});

	it("reads lock pids and keeps id-less queue lines", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const lock = `${userHomePath}/x.lock`;
			writeFileSync(lock, "4242\n");
			expect(await readLiveLockPid(lock, () => true)).toBe(4242);
			expect(await readLiveLockPid(lock, () => false)).toBe(0);
			expect(await readLiveLockPid(`${userHomePath}/missing.lock`, () => true)).toBe(0);
			const kept = await filterStillOpen(
				`${NOW.toISOString()} [foo] board idle: do the next plan step`,
				async () => "",
			);
			expect(kept).toEqual({ kept: `${NOW.toISOString()} [foo] board idle: do the next plan step`, dropped: 0 });
		});
	});
});
