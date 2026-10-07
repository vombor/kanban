// Doctor row: is anything Kanban-managed left under Cline's own dir (~/.cline)? Kanban writes nothing there (user
// rule, 2026-10-07): cards get Kanban's Cline rules as worktree rules and the notice opt-out per launch. Older
// `kanban setup` runs (and the legacy kit) installed the rules globally and left backups next to Cline's settings.
// Read-only, and never fixed automatically: the files sit among the user's own Cline settings, so the row prints the
// command and the user runs it.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { quoteShellArg } from "../core/shell";
import { CLINE_RULE_FILES } from "../prompts/cline-rules";
import type { DoctorFinding } from "./doctor-report";

export interface ClineDirCheckPaths {
	/** Cline's global rules dir (`<CLINE_DIR or ~/.cline>/rules`). */
	rulesDir: string;
	/** Cline's providers.json; its dir also holds models.json and the backups `kanban setup` made. */
	providersPath: string;
}

const KANBAN_SETUP_BACKUP_PATTERN = /\.bak-before-kanban-setup-\d{8}T\d{6}Z$/u;

async function listFiles(dir: string): Promise<string[]> {
	return await readdir(dir).catch(() => []);
}

/** Rule files byte-identical to Kanban's copy: an older `kanban setup` or the legacy kit put them there. */
async function findKanbanGlobalRules(rulesDir: string): Promise<string[]> {
	const names = new Set(await listFiles(rulesDir));
	const found: string[] = [];
	for (const [name, content] of Object.entries(CLINE_RULE_FILES)) {
		if (names.has(name) && (await readFile(join(rulesDir, name), "utf8").catch(() => null)) === content) {
			found.push(join(rulesDir, name));
		}
	}
	return found;
}

function removeCommand(paths: string[]): string {
	return `rm ${paths.map((path) => quoteShellArg(path)).join(" ")}`;
}

export async function checkKanbanFilesUnderClineDir(paths: ClineDirCheckPaths): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	const rules = await findKanbanGlobalRules(paths.rulesDir);
	if (rules.length > 0) {
		findings.push({
			level: "warn",
			area: "setup",
			message: `Kanban's Cline rules in Cline's global rules dir (${paths.rulesDir}): ${rules.length} file(s). Cards now get them as worktree rules (.cline/rules/kanban-*), so these load twice and reach your own Cline sessions too`,
			hint: removeCommand(rules),
		});
	}
	const settingsDir = dirname(paths.providersPath);
	const backups = (await listFiles(settingsDir))
		.filter((name) => KANBAN_SETUP_BACKUP_PATTERN.test(name))
		.map((name) => join(settingsDir, name));
	if (backups.length > 0) {
		findings.push({
			level: "info",
			area: "setup",
			message: `${backups.length} backup(s) an older kanban setup left in ${settingsDir} (they may hold API keys)`,
			hint: removeCommand(backups),
		});
	}
	if (findings.length === 0) {
		return [
			{
				level: "pass",
				area: "setup",
				message: `no Kanban rules or backups under Cline's dir (${dirname(paths.rulesDir)})`,
			},
		];
	}
	return findings;
}
