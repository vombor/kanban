// The project preview on demand for QA (kit `qa.preview = { pidFile, start, stop }`). Some projects' screenshot
// tooling goes through the project's preview, which should otherwise run only when the user starts it. The QA
// gate starts it before a QA card when it is down, and stops it after `pipeline.qa.previewIdleMin` with no QA card
// queued or running, but only if the preview's pid is still the one the gate started: the user's Preview button
// restarts it under a new pid, so a preview the user opened is never stopped. The started pid is kept in
// `run/qa-preview-<workspaceId>.pid`, so a worker restart doesn't lose it.
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (ensureQaPreview, stopQaPreviewIfIdle:
// 781442d, 834fbad).
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { KitQaPreview } from "../kits/kit-schema";
import { getQaPreviewMarkPath } from "../state/kanban-home";

const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 60_000;

export interface QaPreviewShellResult {
	code: number | null;
	output: string;
}

export interface QaPreviewDependencies {
	runShell?: (command: string, cwd: string, timeoutMs: number) => Promise<QaPreviewShellResult>;
	isPidAlive?: (pid: number) => boolean;
	getMarkPath?: (workspaceId: string) => string;
	now?: () => number;
	log: (message: string) => void;
}

export interface QaPreviewController {
	/** Before a QA card starts. */
	ensure: (input: { workspaceId: string; repoPath: string; preview: KitQaPreview }) => Promise<void>;
	/** After each QA pass over the workspace; `qaActive` = a QA card is queued or running. */
	stopIfIdle: (input: {
		workspaceId: string;
		repoPath: string;
		preview: KitQaPreview | null;
		qaActive: boolean;
		idleMin: number;
	}) => Promise<void>;
}

export function runPreviewShell(command: string, cwd: string, timeoutMs: number): Promise<QaPreviewShellResult> {
	return new Promise((resolvePromise) => {
		execFile("sh", ["-c", command], { cwd, timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			resolvePromise({ code, output: `${stderr}${stdout}`.trim() });
		});
	});
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readPid(path: string): Promise<number | null> {
	try {
		const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

export function createQaPreviewController(deps: QaPreviewDependencies): QaPreviewController {
	const runShell = deps.runShell ?? runPreviewShell;
	const isPidAlive = deps.isPidAlive ?? isProcessAlive;
	const getMarkPath = deps.getMarkPath ?? ((workspaceId: string) => getQaPreviewMarkPath(workspaceId));
	const now = deps.now ?? Date.now;
	const idleSince = new Map<string, number>();

	return {
		ensure: async ({ workspaceId, repoPath, preview }) => {
			idleSince.delete(workspaceId);
			const pidFile = resolve(repoPath, preview.pidFile);
			const running = await readPid(pidFile);
			if (running && isPidAlive(running)) {
				return;
			}
			const result = await runShell(preview.start, repoPath, START_TIMEOUT_MS);
			const started = await readPid(pidFile);
			if (result.code === 0 && started && isPidAlive(started)) {
				const mark = getMarkPath(workspaceId);
				await mkdir(dirname(mark), { recursive: true });
				await writeFile(mark, String(started), "utf8");
				deps.log(
					`qa-preview ${workspaceId}: started the preview for QA (pid ${started}); stopped again when QA is idle`,
				);
			} else {
				deps.log(`qa-preview ${workspaceId}: start FAILED (exit ${result.code}): ${result.output.slice(-200)}`);
			}
		},
		stopIfIdle: async ({ workspaceId, repoPath, preview, qaActive, idleMin }) => {
			const mark = getMarkPath(workspaceId);
			const mine = await readPid(mark);
			if (!preview || mine === null) {
				idleSince.delete(workspaceId);
				return;
			}
			if (qaActive) {
				idleSince.delete(workspaceId);
				return;
			}
			const since = idleSince.get(workspaceId) ?? now();
			idleSince.set(workspaceId, since);
			if (now() - since < idleMin * 60_000) {
				return;
			}
			idleSince.delete(workspaceId);
			await rm(mark, { force: true });
			const current = await readPid(resolve(repoPath, preview.pidFile));
			if (!current || !isPidAlive(current)) {
				return;
			}
			if (current !== mine) {
				deps.log(
					`qa-preview ${workspaceId}: preview pid ${current} isn't the one the QA gate started (${mine}); the user's, left running`,
				);
				return;
			}
			const result = await runShell(preview.stop, repoPath, STOP_TIMEOUT_MS);
			deps.log(
				`qa-preview ${workspaceId}: QA idle ${idleMin} min; stopped the preview the QA gate started (pid ${mine}, exit ${result.code})`,
			);
		},
	};
}
