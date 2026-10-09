// Doctor rows for project shortcuts (src/projects/project-shortcut-store.ts). Shortcuts live in Kanban's shortcut
// store; a project's own Kanban config file (getProjectKanbanConfigPath) is read once, for the import, and ignored:
// - the shortcuts the import brought in are listed once for review (a card could have written the main checkout's
//   copy through a symlinked `.cline` before the import), then marked listed in the store's import record;
// - a repo copy that still has shortcuts is reported as ignored (or as "imported at the next read" before then).
// Never edits a project's files: removing the repo copy is the user's commit.
import { quoteShellArg } from "../core/shell";
import {
	markProjectShortcutImportListed,
	type ProjectShortcutImportSource,
	readBaseBranchProjectShortcuts,
	readMainCheckoutProjectShortcuts,
	readProjectShortcutStore,
	resolveProjectShortcutBaseBranch,
} from "../projects/project-shortcut-store";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import type { DoctorFinding } from "./doctor-report";

export interface ProjectShortcutCheckDeps {
	/** Tests: the Kanban home. */
	homePath?: string;
	/** Tests: the base branch the repo copy is read from. */
	resolveBaseBranch?: (entry: RuntimeWorkspaceIndexEntry) => Promise<string | null>;
	now?: () => Date;
}

function describeSource(source: ProjectShortcutImportSource): string {
	return source.kind === "base-branch"
		? `${source.path} on ${source.ref} (${source.commit.slice(0, 8)})`
		: `${source.path} (the main checkout's working tree)`;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function checkProject(
	entry: RuntimeWorkspaceIndexEntry,
	deps: ProjectShortcutCheckDeps,
): Promise<DoctorFinding[]> {
	const { workspaceId, repoPath } = entry;
	const findings: DoctorFinding[] = [];
	let store: Awaited<ReturnType<typeof readProjectShortcutStore>>;
	try {
		store = await readProjectShortcutStore(workspaceId, deps.homePath);
	} catch (error) {
		return [{ level: "fail", area: "project", message: `${workspaceId}: shortcuts: ${toErrorMessage(error)}` }];
	}

	const imported = store?.imported;
	if (imported?.source && imported.shortcuts && imported.shortcuts.length > 0 && !imported.listedAt) {
		findings.push({
			level: "warn",
			area: "project",
			message: [
				`${workspaceId}: ${imported.shortcuts.length} shortcut(s) imported from ${describeSource(imported.source)} at ${imported.at}; check each is yours (a card could have written that file before the import; this is listed once):`,
				...imported.shortcuts.map((shortcut) => `    ${shortcut.label}: ${shortcut.command}`),
			].join("\n"),
			hint: `kanban shortcut remove --project ${quoteShellArg(repoPath)} --label <label>`,
		});
		await markProjectShortcutImportListed(workspaceId, { homePath: deps.homePath, now: deps.now });
	}

	const baseBranch = await (deps.resolveBaseBranch?.(entry) ??
		resolveProjectShortcutBaseBranch(workspaceId, repoPath));
	const copies = [
		await readBaseBranchProjectShortcuts(repoPath, baseBranch).catch(() => null),
		await readMainCheckoutProjectShortcuts(repoPath).catch(() => null),
	].filter((copy) => copy !== null && copy.shortcuts.length > 0);
	for (const copy of copies) {
		if (!copy) {
			continue;
		}
		findings.push(
			store
				? {
						level: "info",
						area: "project",
						message: `${workspaceId}: ${describeSource(copy.source)} still has ${copy.shortcuts.length} shortcut(s); it is ignored (shortcuts are in Kanban's store, changed with kanban shortcut or the settings dialog). Remove them from the repo when convenient`,
						hint: `kanban shortcut list --project ${quoteShellArg(repoPath)}`,
					}
				: {
						level: "info",
						area: "project",
						message: `${workspaceId}: ${describeSource(copy.source)} has ${copy.shortcuts.length} shortcut(s); the next read imports them into Kanban's store once, after which the file is ignored`,
					},
		);
		if (!store) {
			// Only the copy the import will take matters before then (the base branch first).
			break;
		}
	}
	return findings;
}

export async function checkProjectShortcuts(
	entries: RuntimeWorkspaceIndexEntry[],
	deps: ProjectShortcutCheckDeps = {},
): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	for (const entry of entries) {
		findings.push(...(await checkProject(entry, deps)));
	}
	return findings;
}
