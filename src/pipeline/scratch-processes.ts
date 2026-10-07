// Stops the servers a QA agent left running in its scratch copies. The QA prompt tells it to leave them up (it must
// never run the project's preview:stop, which stops the user's shared preview), so the QA gate stops them after it
// has ingested the verdict. Matching is by location, as for task worktrees: every process whose cwd or executable
// is inside a scratch dir, through the process reaper's rules (never the server, its ancestors or the worker,
// never a process other cards use).
//
// Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597 (ingestQaOnce: killUnder the scratch dir
// and its `-<base>` copy; 66797d9).
import { createProcessReaper, expandPathVariants, isProcessInPaths } from "../server/process-reaper";
import { createProcProcessTableReader, isProcessTableSupported } from "../server/process-table";

export async function stopScratchProcesses(dirs: readonly string[], log: (message: string) => void): Promise<number> {
	if (!isProcessTableSupported() || dirs.length === 0) {
		return 0;
	}
	const reaper = createProcessReaper({ reader: createProcProcessTableReader(), log });
	const paths = expandPathVariants(dirs);
	const snapshot = await reaper.snapshot();
	const targets = snapshot.entries
		.filter((entry) => isProcessInPaths(entry, paths))
		.map((entry) => ({ entry, ownPaths: paths }));
	if (targets.length === 0) {
		return 0;
	}
	const outcomes = await reaper.terminate(targets);
	return outcomes.filter((outcome) => outcome.action === "terminated" || outcome.action === "killed").length;
}
