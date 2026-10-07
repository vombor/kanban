// `kanban setup`: plan every machine step, trust every registered project for Claude Code / Codex, then apply what
// changes (nothing with `dryRun`). Re-running it is safe: each step only adds what is missing.
import { stat } from "node:fs/promises";

import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import { type MachineSetupOptions, planMachineSetup, type SetupStepPlan } from "./machine-setup";
import {
	type AgentTrustConfigPaths,
	fixWorkspaceTrust,
	getAgentTrustConfigPaths,
	readWorkspaceTrust,
	workspaceTrustNeedsFix,
} from "./workspace-trust-report";

export interface SetupStepOutcome {
	plan: Omit<SetupStepPlan, "apply">;
	/** Lines about what was written; empty for a dry run or a step with nothing to do. */
	applied: string[];
	error: string | null;
}

export interface SetupTrustOutcome {
	repoPath: string;
	needsFix: boolean;
	lines: string[];
}

export interface SetupResult {
	dryRun: boolean;
	steps: SetupStepOutcome[];
	trust: SetupTrustOutcome[];
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function runMachineSetup(
	options: MachineSetupOptions & {
		dryRun: boolean;
		entries: RuntimeWorkspaceIndexEntry[];
		trustPaths?: AgentTrustConfigPaths;
	},
): Promise<SetupResult> {
	const plans = await planMachineSetup(options);
	const steps: SetupStepOutcome[] = [];
	for (const { apply, ...plan } of plans) {
		if (options.dryRun || !apply) {
			steps.push({ plan, applied: [], error: null });
			continue;
		}
		try {
			steps.push({ plan, applied: await apply(), error: null });
		} catch (error) {
			steps.push({ plan, applied: [], error: error instanceof Error ? error.message : String(error) });
		}
	}
	const trustPaths = options.trustPaths ?? getAgentTrustConfigPaths();
	const trust: SetupTrustOutcome[] = [];
	for (const entry of options.entries) {
		if (!(await isDirectory(entry.repoPath))) {
			continue;
		}
		const status = await readWorkspaceTrust(entry.repoPath, trustPaths);
		const needsFix = workspaceTrustNeedsFix(status);
		trust.push({
			repoPath: entry.repoPath,
			needsFix,
			lines: needsFix && !options.dryRun ? await fixWorkspaceTrust(status, trustPaths) : [],
		});
	}
	return { dryRun: options.dryRun, steps, trust };
}

export function setupFailed(result: SetupResult): boolean {
	return result.steps.some((step) => step.error !== null || step.plan.status === "error");
}
