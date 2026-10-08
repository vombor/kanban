import { type ChildProcess, execFileSync, type spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCalibrateCommand } from "../../../../src/commands/bench-calibrate";
import { getCalibrationPaths, getKanbanGlobalConfigPath } from "../../../../src/state/kanban-home";
import { loadWorkspaceContext, mutateWorkspaceState } from "../../../../src/state/workspace-state";
import { createGitTestEnv } from "../../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../../utilities/kanban-home";
import { realPath } from "../../../utilities/temp-dir";
import { createBoard, createCard } from "../../../utilities/workspace-state-store";

async function createWorkspace(userHomePath: string, kit: string | null) {
	const repoPath = join(userHomePath, "repo");
	mkdirSync(repoPath);
	const env = createGitTestEnv();
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath, env });
	writeFileSync(join(repoPath, "a.txt"), "a\n");
	execFileSync("git", ["add", "."], { cwd: repoPath, env });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"], { cwd: repoPath, env });
	const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoPath, env, encoding: "utf8" }).trim();
	const { workspaceId } = await loadWorkspaceContext(repoPath);
	await mutateWorkspaceState(repoPath, () => ({
		board: createBoard({ trash: [createCard({ id: "f80db", prompt: "Build the login.\n\nFINAL STEP: reply." })] }),
		value: null,
	}));
	if (kit) {
		writeFileSync(
			getKanbanGlobalConfigPath(),
			JSON.stringify({ workspaces: { [workspaceId]: { kit: { name: kit } } } }),
		);
	}
	const writeSpec = (models: unknown[]) => {
		const path = join(userHomePath, "spec.json");
		writeFileSync(
			path,
			JSON.stringify({
				name: "t1",
				workspace: workspaceId,
				sets: [
					{ id: "A", ref: head, base: head, fromCard: "f80db", expect: "PASS" },
					{ id: "B", ref: "nosuchref", base: head, fromCard: "gone0" },
				],
				models,
			}),
		);
		return path;
	};
	return { repoPath, workspaceId, head, writeSpec };
}

/** A fake node spawn: records the call and returns a child with `pid` (undefined: the spawn failed). */
function createFakeSpawn(pid: number | undefined) {
	const child = { pid, on: vi.fn(), unref: vi.fn() };
	const fake = vi.fn((..._args: unknown[]) => child as unknown as ChildProcess);
	return { fake, child, spawn: fake as unknown as typeof spawn };
}

function captureStdout(): string[] {
	const output: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		output.push(String(chunk));
		return true;
	});
	return output;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("kanban bench calibrate", () => {
	it("refuses a workspace whose kit doesn't list the calibration feature (the default kit)", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { writeSpec, workspaceId } = await createWorkspace(userHomePath, null);
			const spec = writeSpec([{ key: "sol", agent: "codex" }]);
			await expect(runCalibrateCommand(spec, {})).rejects.toThrow(
				`workspace ${workspaceId} is on kit default, which doesn't list the calibration feature (--force to run anyway)`,
			);
		});
	});

	it("refuses rule names the kit doesn't have", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { writeSpec } = await createWorkspace(userHomePath, "team");
			const spec = writeSpec([{ key: "haiku", agent: "cline", rules: ["drive", "nope"] }]);
			await expect(runCalibrateCommand(spec, { print: true })).rejects.toThrow(
				/model haiku: rule nope is not in kit team's qa\.rules \(drive\)/u,
			);
		});
	});

	it("--print checks the dev prompts and refs without creating cards", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { writeSpec, head } = await createWorkspace(userHomePath, "team");
			const spec = writeSpec([{ key: "haiku", agent: "cline", rules: ["drive"] }]);
			const output: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
				output.push(String(chunk));
				return true;
			});
			expect(await runCalibrateCommand(spec, { print: true })).toBe(0);
			const text = output.join("");
			expect(text).toContain(`A: f80db prompt 36 chars → requirements 16; ref ${head} base ${head}`);
			expect(text).toContain(`B: gone0 prompt MISSING; ref BAD base ${head}`);
			expect(text).toContain("2 runs, 3 at a time");
		});
	});

	it("starts a detached --worker for the calibration and hands it the runner lock", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { writeSpec, workspaceId, repoPath } = await createWorkspace(userHomePath, "team");
			const spec = writeSpec([{ key: "haiku", agent: "cline", rules: ["drive"] }]);
			const output = captureStdout();
			// A live pid other than this process: the worker is running.
			const workerPid = process.ppid;
			const { fake, child, spawn } = createFakeSpawn(workerPid);
			expect(await runCalibrateCommand(spec, { force: true }, { spawn })).toBe(0);
			expect(fake).toHaveBeenCalledTimes(1);
			const [command, args, spawnOptions] = fake.mock.calls[0] as [string, string[], Record<string, unknown>];
			expect(command).toBe(process.execPath);
			expect(args.slice(-7)).toEqual(["bench", "calibrate", spec, "--worker", "--project", workspaceId, "--force"]);
			expect(spawnOptions).toMatchObject({ cwd: realPath(repoPath), detached: true });
			expect(child.unref).toHaveBeenCalled();
			const paths = getCalibrationPaths(workspaceId, "t1");
			expect(readFileSync(paths.lock, "utf8")).toBe(`${workerPid}\n`);
			expect(output.join("")).toContain(`calibration t1 started (pid ${workerPid}); log `);
			// A second start while that worker lives is refused, and spawns nothing.
			await expect(runCalibrateCommand(spec, {}, { spawn })).rejects.toThrow(
				`calibration t1 is already running (pid ${workerPid}, ${paths.lock})`,
			);
			await expect(runCalibrateCommand(spec, { foreground: true })).rejects.toThrow(
				`calibration t1 is already running (pid ${workerPid}`,
			);
			expect(fake).toHaveBeenCalledTimes(1);
		});
	});

	it("releases the runner lock when the worker could not be spawned", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const { writeSpec, workspaceId } = await createWorkspace(userHomePath, "team");
			const spec = writeSpec([{ key: "haiku", agent: "cline", rules: ["drive"] }]);
			const output = captureStdout();
			const { fake, spawn } = createFakeSpawn(undefined);
			expect(await runCalibrateCommand(spec, {}, { spawn })).toBe(0);
			expect(fake).toHaveBeenCalledTimes(1);
			expect(output.join("")).toContain("calibration t1 started (pid ?)");
			expect(existsSync(getCalibrationPaths(workspaceId, "t1").lock)).toBe(false);
		});
	});
});
