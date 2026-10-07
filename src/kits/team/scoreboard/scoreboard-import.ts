// The cutover's copy of the legacy kit's scoreboard.jsonl into the team kit's `data/<id>/scoreboard.jsonl`
// (`kanban pipeline import-legacy`, P5-2; plan §2.4: foo's `bench/scoreboard.jsonl` moves up one level). Same line
// format (scoreboard-line.ts). A legacy line already in the file (the same JSON) is not added again, so importing
// twice adds nothing. The legacy lines go first: they are older, and parseScoreboard keeps the last line of a
// (card, round, …) key, so a newer Kanban line for the same round still wins.
import { readFile } from "node:fs/promises";

import { lockedFileSystem } from "../../../fs/locked-file-system";

export interface ScoreboardImportPlan {
	/** Legacy lines not in the file yet, in legacy order. */
	added: string[];
	/** Legacy lines the file already has. */
	alreadyThere: number;
	/** 1-based numbers of legacy lines that don't parse (not copied). */
	badLegacyLines: number[];
}

async function readTextOrEmpty(path: string): Promise<string> {
	return await readFile(path, "utf8").catch((error: unknown) => {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return "";
		}
		throw error;
	});
}

function canonicalLines(text: string): Array<{ number: number; line: string | null }> {
	return text.split("\n").flatMap((raw, index): Array<{ number: number; line: string | null }> => {
		if (!raw.trim()) {
			return [];
		}
		try {
			return [{ number: index + 1, line: JSON.stringify(JSON.parse(raw)) }];
		} catch {
			return [{ number: index + 1, line: null }];
		}
	});
}

export function planScoreboardImport(legacyText: string, currentText: string): ScoreboardImportPlan {
	const present = new Set(canonicalLines(currentText).flatMap((entry) => (entry.line ? [entry.line] : [])));
	const plan: ScoreboardImportPlan = { added: [], alreadyThere: 0, badLegacyLines: [] };
	for (const { number, line } of canonicalLines(legacyText)) {
		if (line === null) {
			plan.badLegacyLines.push(number);
		} else if (present.has(line)) {
			plan.alreadyThere += 1;
		} else {
			present.add(line);
			plan.added.push(line);
		}
	}
	return plan;
}

/** Plans (and unless `dryRun`, writes) the import. The caller rebuilds scoreboard.md when lines were added. */
export async function importLegacyScoreboard(input: {
	from: string;
	to: string;
	dryRun: boolean;
}): Promise<ScoreboardImportPlan> {
	const legacyText = await readTextOrEmpty(input.from);
	if (input.dryRun) {
		return planScoreboardImport(legacyText, await readTextOrEmpty(input.to));
	}
	return await lockedFileSystem.withLock({ path: input.to, type: "file" }, async () => {
		const currentText = await readTextOrEmpty(input.to);
		const plan = planScoreboardImport(legacyText, currentText);
		if (plan.added.length > 0) {
			const rest = currentText.trim() ? `${currentText.replace(/\n*$/u, "")}\n` : "";
			await lockedFileSystem.writeTextFileAtomic(input.to, `${plan.added.join("\n")}\n${rest}`, { lock: null });
		}
		return plan;
	});
}
