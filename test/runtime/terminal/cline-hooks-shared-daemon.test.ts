import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseHooksIngestArgs } from "../../../src/commands/hooks";
import type { RuntimeHookEvent } from "../../../src/core/api-contract";
import type { TaskGuardrails } from "../../../src/guardrails/task-guardrails";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { evaluateClineGuard } from "../../../src/terminal/cline-guard";
import { createLandRepo } from "../../utilities/land-repo";

// foo 4189a (10/07): foo git-ignores `.cline/`, so every task worktree got `.cline` as a symlink to the main
// checkout's, and all Cline cards of the project shared one `.cline/hooks`. The card launched last wrote everyone's
// hook scripts (its --task-id and guard policy), so 4189a's writes were judged against 6f756's worktree. Cline's hub
// daemon runs each session's hooks from that session's workspace with the daemon's env (the first card's).
const HOOK_NAMES = [
	"TaskStart",
	"TaskResume",
	"TaskCancel",
	"TaskComplete",
	"TaskError",
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
] as const;

/** The `kanban hooks notify` invocations in a bash hook script, as commander would hand them to the command. */
function readNotifyInvocations(script: string): Array<{ event: RuntimeHookEvent; options: Record<string, string> }> {
	return script
		.split("\n")
		.filter((line) => line.includes("'notify'"))
		.map((line) => {
			const words = [...line.matchAll(/'((?:[^']|'\\'')*)'/gu)].map((match) => match[1] ?? "");
			const args = words.slice(words.indexOf("notify") + 1);
			const options: Record<string, string> = {};
			for (let index = 0; index < args.length; index += 2) {
				const key = (args[index] ?? "")
					.replace(/^--/u, "")
					.replace(/-(\w)/gu, (_, letter: string) => letter.toUpperCase());
				options[key] = args[index + 1] ?? "";
			}
			return { event: options.event as RuntimeHookEvent, options };
		});
}

function readGuardPolicy(script: string): Record<string, unknown> {
	const encoded = /'--policy-base64' '([A-Za-z0-9+/=]+)'/u.exec(script)?.[1] ?? "";
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

/** A cline 3.0.69 PreToolUse payload of the session working in `workspaceRoot`. */
function toolCallPayload(workspaceRoot: string | null, path: string): Record<string, unknown> {
	return {
		clineVersion: "3.0.69",
		hookName: "tool_call",
		taskId: "1791411244036_bhjdk",
		...(workspaceRoot ? { workspaceRoots: [workspaceRoot] } : {}),
		tool_call: { id: "1", name: "editor", input: { path, new_text: "x" } },
		preToolUse: { toolName: "editor", parameters: { path } },
	};
}

describe("Cline cards sharing one hub daemon", () => {
	const originalHome = process.env.HOME;
	const originalTaskId = process.env.KANBAN_HOOK_TASK_ID;
	const originalWorkspaceId = process.env.KANBAN_HOOK_WORKSPACE_ID;
	let home: string;
	let repo: ReturnType<typeof createLandRepo>;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "kanban-cline-daemon-home-"));
		process.env.HOME = home;
		repo = createLandRepo();
		repo.write(repo.repoPath, ".gitignore", ".cline/\n");
		repo.commitAll(repo.repoPath, "ignore .cline");
		// The main checkout's .cline: a user rule and workflow, a user hook, and a hook Kanban wrote for another session.
		repo.write(repo.repoPath, ".cline/rules/user-rule.md", "Use tabs.\n");
		repo.write(repo.repoPath, ".cline/workflows/release.md", "Release steps.\n");
		repo.write(repo.repoPath, ".cline/hooks/PostToolUse", "#!/usr/bin/env bash\necho user-owned\n");
		repo.write(repo.repoPath, ".cline/hooks/TaskStart", "# kanban-managed: cline-cli hook (TaskStart)\n# other\n");
		repo.write(repo.repoPath, ".cline/rules/kanban-home-agent.md", "Orchestrator prompt.\n");
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		for (const [key, value] of [
			["KANBAN_HOOK_TASK_ID", originalTaskId],
			["KANBAN_HOOK_WORKSPACE_ID", originalWorkspaceId],
		] as const) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		repo.cleanup();
		rmSync(home, { recursive: true, force: true });
	});

	/** A worktree as task-worktree.ts makes it for this repo: `.cline` mirrored as a symlink, listed in info/exclude. */
	function addMirroredWorktree(taskId: string): string {
		const worktree = repo.addWorktree(taskId);
		symlinkSync(join(repo.repoPath, ".cline"), join(worktree, ".cline"), "dir");
		repo.write(
			repo.repoPath,
			".git/info/exclude",
			"# kanban-managed-symlinked-ignored-paths:start\n# Keep symlinked ignored paths ignored inside Kanban task worktrees.\n/.cline\n# kanban-managed-symlinked-ignored-paths:end\n",
		);
		return realpathSync(worktree);
	}

	function guardrailsFor(worktreePath: string): TaskGuardrails {
		return {
			worktreePath,
			projectPath: repo.repoPath,
			protectedDirs: [repo.repoPath],
			confineWrites: true,
			gitCommonDir: join(repo.repoPath, ".git"),
			tempDirs: ["/tmp"],
			linkedDirs: [],
			extraWritableDirs: [],
			sharedBranches: ["main"],
			deniedCommands: [],
			ownBranchPush: false,
			role: "card",
			isolation: null,
		};
	}

	async function launchCard(taskId: string, worktree: string) {
		return await prepareAgentLaunch({
			taskId,
			agentId: "cline",
			binary: "cline",
			args: [],
			autonomousModeEnabled: true,
			cwd: worktree,
			prompt: "Fix the bug",
			workspaceId: "foo",
			guardrails: guardrailsFor(worktree),
		});
	}

	it("gives every card its own hooks: guard, notify and ingest decide with that card, whatever the daemon env says", async () => {
		const cards = ["card-a", "card-b", "card-c"].map((taskId) => ({ taskId, worktree: addMirroredWorktree(taskId) }));
		// The daemon's env is the first card's (it started the hub daemon).
		process.env.KANBAN_HOOK_TASK_ID = "card-a";
		process.env.KANBAN_HOOK_WORKSPACE_ID = "foo";
		// Launched one after another, as the 22:13Z restart resumed foo's seven Cline cards.
		for (const card of cards) {
			const launch = await launchCard(card.taskId, card.worktree);
			expect(launch.sessionWarning).toContain("PostToolUse");
		}

		for (const card of cards) {
			const clineDir = join(card.worktree, ".cline");
			const preToolUse = readFileSync(join(clineDir, "hooks", "PreToolUse"), "utf8");
			expect(readGuardPolicy(preToolUse).worktreePath).toBe(card.worktree);
			expect(lstatSync(clineDir).isSymbolicLink()).toBe(false);
			// The user's shared files are still there, linked; Kanban's from other sessions are not.
			expect(readFileSync(join(clineDir, "rules", "user-rule.md"), "utf8")).toBe("Use tabs.\n");
			expect(readFileSync(join(clineDir, "workflows", "release.md"), "utf8")).toBe("Release steps.\n");
			expect(existsSync(join(clineDir, "rules", "kanban-home-agent.md"))).toBe(false);
			expect(readFileSync(join(clineDir, "hooks", "PostToolUse"), "utf8")).toBe(
				"#!/usr/bin/env bash\necho user-owned\n",
			);

			// The symptom: this card's own write is judged with its own worktree, not the last-launched card's.
			const ownWrite = join(card.worktree, "src", "lib", "analytics.ts");
			expect(
				evaluateClineGuard(toolCallPayload(card.worktree, ownWrite), readGuardPolicy(preToolUse) as never),
			).toEqual({
				cancel: false,
			});

			for (const hookName of HOOK_NAMES) {
				const script = readFileSync(join(clineDir, "hooks", hookName), "utf8");
				const invocations = readNotifyInvocations(script);
				if (hookName === "PostToolUse") {
					continue; // the user's own script
				}
				expect(invocations.length, hookName).toBeGreaterThan(0);
				for (const { event, options } of invocations) {
					expect(options.taskId, hookName).toBe(card.taskId);
					expect(options.workspaceRoot, hookName).toBe(card.worktree);
					const payload = JSON.stringify({ ...toolCallPayload(card.worktree, ownWrite), hookName });
					expect(parseHooksIngestArgs(event, options, undefined, payload).taskId).toBe(card.taskId);
				}
			}
		}

		// The main checkout's hooks dir is untouched: no card wrote its hooks there.
		expect(readFileSync(join(repo.repoPath, ".cline", "hooks", "TaskStart"), "utf8")).toBe(
			"# kanban-managed: cline-cli hook (TaskStart)\n# other\n",
		);
		expect(existsSync(join(repo.repoPath, ".cline", "hooks", "PreToolUse"))).toBe(false);
	});

	it("refuses a hook call from another card's session, or one whose payload names no session", async () => {
		const cardA = addMirroredWorktree("card-a");
		const cardB = addMirroredWorktree("card-b");
		await launchCard("card-a", cardA);
		const script = readFileSync(join(cardA, ".cline", "hooks", "PreToolUse"), "utf8");
		const policy = readGuardPolicy(script) as never;
		const write = join(cardB, "src", "a.ts");

		const foreign = evaluateClineGuard(toolCallPayload(cardB, write), policy);
		expect(foreign.cancel).toBe(true);
		expect(foreign.errorMessage).toContain(`written for the card in ${cardA}`);
		expect(foreign.errorMessage).toContain(`works in ${cardB}`);
		expect(evaluateClineGuard(toolCallPayload(null, write), policy).cancel).toBe(true);

		const [notify] = readNotifyInvocations(script);
		expect(notify).toBeDefined();
		if (!notify) {
			return;
		}
		expect(() =>
			parseHooksIngestArgs(notify.event, notify.options, undefined, JSON.stringify(toolCallPayload(cardB, write))),
		).toThrow(`works in ${cardB}`);
		expect(() =>
			parseHooksIngestArgs(notify.event, notify.options, undefined, JSON.stringify(toolCallPayload(null, write))),
		).toThrow("without workspaceRoots");
		// A script from before the workspace root (or one without ids) is refused, never reported for the env's card.
		process.env.KANBAN_HOOK_TASK_ID = "card-b";
		process.env.KANBAN_HOOK_WORKSPACE_ID = "foo";
		const { workspaceRoot: _root, ...legacy } = notify.options;
		const { taskId: _taskId, workspaceId: _workspaceId, ...withoutIds } = legacy;
		const payload = JSON.stringify(toolCallPayload(cardA, write));
		expect(() => parseHooksIngestArgs(notify.event, legacy, undefined, payload)).toThrow("--workspace-root");
		expect(() => parseHooksIngestArgs(notify.event, withoutIds, undefined, payload)).toThrow("--workspace-root");
		expect(() =>
			parseHooksIngestArgs(notify.event, { ...withoutIds, workspaceRoot: cardA }, undefined, payload),
		).toThrow("--task-id and --workspace-id");
	});

	it("writes no notify into a launch without a card id, so nothing falls back to the daemon's env", async () => {
		const worktree = addMirroredWorktree("card-a");
		await prepareAgentLaunch({
			taskId: "card-a",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: worktree,
			prompt: "Fix the bug",
			guardrails: guardrailsFor(worktree),
		});
		for (const hookName of HOOK_NAMES.filter((name) => name !== "PostToolUse")) {
			const script = readFileSync(join(worktree, ".cline", "hooks", hookName), "utf8");
			expect(script, hookName).not.toContain("'notify'");
		}
		expect(readFileSync(join(worktree, ".cline", "hooks", "PreToolUse"), "utf8")).toContain("'cline-guard'");
	});

	it("fails the launch on a .cline symlink Kanban didn't mirror", async () => {
		const worktree = realpathSync(repo.addWorktree("card-a"));
		const elsewhere = join(repo.root, "elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		symlinkSync(elsewhere, join(worktree, ".cline"), "dir");
		await expect(launchCard("card-a", worktree)).rejects.toThrow("is a symlink Kanban didn't create");
		expect(existsSync(join(elsewhere, "hooks"))).toBe(false);
	});
});
