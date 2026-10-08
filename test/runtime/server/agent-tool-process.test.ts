import { describe, expect, it } from "vitest";

import { createAgentToolProcessFinder, findAgentToolProcess } from "../../../src/server/process-reaper";
import { createFakeProcessTable, createProcessEntry } from "../../utilities/fake-process-table";

const WORKTREE = "/kanban-test-worktrees/8ab87/foo";
const OTHER = "/kanban-test-worktrees/552ba/foo";

// Recovery asks this while a Cline shell tool call is pending: a long `npm test` is no silent stall.
describe("findAgentToolProcess", () => {
	const base = [
		createProcessEntry({ pid: 1, ppid: 0, command: "init", cwd: "/" }),
		createProcessEntry({ pid: 100, ppid: 1, command: "kanban", cwd: "/home/dev" }),
		// The card's agent (its PTY child), and the shared hub daemon sitting in another card's worktree.
		createProcessEntry({ pid: 4604, ppid: 100, command: "cline --tui", cwd: WORKTREE }),
		createProcessEntry({ pid: 300, ppid: 1, command: "node cline --cline-hub-daemon", cwd: OTHER }),
	];

	it("finds the agent's own command in the worktree, and a hub daemon's", () => {
		const local = createProcessEntry({ pid: 5000, ppid: 4604, command: "bash -c npm test", cwd: WORKTREE });
		expect(findAgentToolProcess([...base, local], { worktreePaths: [WORKTREE], agentPid: 4604 })).toBe(local);

		const viaHub = createProcessEntry({ pid: 6000, ppid: 300, command: "sh -c npm run build", cwd: WORKTREE });
		const vitest = createProcessEntry({ pid: 6001, ppid: 6000, command: "node vitest", cwd: `${WORKTREE}/web` });
		expect(findAgentToolProcess([...base, viaHub, vitest], { worktreePaths: [WORKTREE], agentPid: 4604 })).toBe(
			viaHub,
		);
	});

	it("ignores the agent itself, other cards' commands, detached servers and zombies", () => {
		const entries = [
			...base,
			// Another card's test run under the hub daemon.
			createProcessEntry({ pid: 6100, ppid: 300, command: "sh -c npm test", cwd: OTHER }),
			// A dev server the agent detached (nohup/setsid): reparented, so it isn't a running tool step.
			createProcessEntry({ pid: 7000, ppid: 1, command: "next dev", cwd: WORKTREE }),
			createProcessEntry({ pid: 7100, ppid: 4604, command: "[sh]", cwd: WORKTREE, state: "Z" }),
		];
		expect(findAgentToolProcess(entries, { worktreePaths: [WORKTREE], agentPid: 4604 })).toBeNull();
		expect(findAgentToolProcess(base, { worktreePaths: [WORKTREE], agentPid: null })).toBeNull();
	});

	it("describes it from the process table, and answers null without one", async () => {
		const table = createFakeProcessTable([
			...base,
			createProcessEntry({ pid: 5000, ppid: 4604, command: "bash -c npm test", cwd: WORKTREE }),
		]);
		expect(await createAgentToolProcessFinder(table.reader)(WORKTREE, 4604)).toBe("pid 5000: bash -c npm test");
		expect(await createAgentToolProcessFinder(null)(WORKTREE, 4604)).toBeNull();
	});
});
