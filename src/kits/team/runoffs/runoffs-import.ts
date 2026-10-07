// The cutover's copy of the legacy kit's runoffs.json into the team kit's (`kanban pipeline import-legacy`, P5-2).
// Same format (runoffs-store.ts), so entries are copied as they are, decided ones too (history: the orchestrator's
// notes and `kanban bench` read them). Entries are matched by name; the legacy kit owned them until the switch, so
// its version wins. Copying the same file again changes nothing.
import { isOpenRunoff, type RunoffEntry, readRunoffs, updateRunoffs } from "./runoffs-store";

export interface RunoffsImportPlan {
	added: string[];
	replaced: string[];
	unchanged: string[];
	/** Copied groups that are still undecided: their cards' PASSes stay held. */
	open: string[];
	/** Legacy entries that don't parse (not copied). */
	issues: string[];
}

function planAgainst(legacy: readonly RunoffEntry[], current: readonly RunoffEntry[]): RunoffsImportPlan {
	const plan: RunoffsImportPlan = { added: [], replaced: [], unchanged: [], open: [], issues: [] };
	for (const entry of legacy) {
		const existing = current.find((candidate) => candidate.name === entry.name);
		if (!existing) {
			plan.added.push(entry.name);
		} else if (JSON.stringify(existing) === JSON.stringify(entry)) {
			plan.unchanged.push(entry.name);
		} else {
			plan.replaced.push(entry.name);
		}
		if (isOpenRunoff(entry)) {
			plan.open.push(entry.name);
		}
	}
	return plan;
}

export async function importLegacyRunoffs(input: {
	from: string;
	to: string;
	dryRun: boolean;
}): Promise<RunoffsImportPlan> {
	const legacy = await readRunoffs(input.from);
	const plan = { ...planAgainst(legacy.runoffs, (await readRunoffs(input.to)).runoffs), issues: legacy.issues };
	if (input.dryRun || (plan.added.length === 0 && plan.replaced.length === 0)) {
		return plan;
	}
	const { value } = await updateRunoffs(input.to, (runoffs) => {
		// Planned again under the lock, against what is in the file now.
		const locked = planAgainst(legacy.runoffs, runoffs);
		for (const entry of legacy.runoffs) {
			const index = runoffs.findIndex((candidate) => candidate.name === entry.name);
			if (index === -1) {
				runoffs.push(structuredClone(entry));
			} else if (locked.replaced.includes(entry.name)) {
				runoffs[index] = structuredClone(entry);
			}
		}
		return locked;
	});
	return { ...value, issues: legacy.issues };
}
