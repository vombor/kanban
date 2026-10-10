// One workspace's QA pipeline pause (issue #23: notes had to stop QA for a calibration and to keep Lemonade within
// RAM, and the only switch was the machine-wide `pipeline.paused`, by hand). `kanban pipeline pause|resume` sets
// `workspaces.<id>.pipeline.paused` through the server's route (src/trpc/pipeline-pause-api.ts: the user and that
// project's own orchestrator), and every change is a `pause` record in the workspace's decision log.
//
// What a paused workspace's pipeline does (the worker reads the flag on every evaluation, so nothing else changes):
// - goes on: snapshots and the scripted checks, the QA gate creating QA cards (queued in Backlog, `qaGate.status
//   "queued"`), ingesting a verdict a QA card already wrote, replacing dead or failed QA cards (queued, not started),
//   recovery (`pipeline.recovery.mode` is its own switch) and the watchdog's reports;
// - held: starting a queued QA card, nudging a QA card for its verdict, landing a PASS, the rework stage (reworks,
//   escalations, the started-check) and the kit features' ticks (the team kit's runoffs).
// On resume all of that acts on the next evaluation, which the route asks for at once. The machine-wide
// `pipeline.paused` is different: it stops the worker for every workspace, recovery included.
import { type LandingMode, updateWorkspacePipelineEntry } from "../config/pipeline-config";
import { DEFAULT_KIT_NAME } from "../kits/resolve-kit";
import type { PipelineDecisionLog } from "./decision-log";

export interface WorkspacePauseChange {
	workspaceId: string;
	paused: boolean;
	/** False when the workspace already was in the asked state (nothing written). */
	changed: boolean;
	/** ISO time of the pause in force, or null. */
	pausedAt: string | null;
	landingMode: LandingMode;
	kitName: string;
}

export interface SetWorkspacePauseInput {
	workspaceId: string;
	paused: boolean;
	/** Who asked: "user" or "orchestrator <taskId>". */
	by: string;
	reason?: string | null;
	decisionLog: PipelineDecisionLog;
	configPath?: string;
	now?: () => number;
}

function readObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** Pauses or resumes the workspace's QA pipeline under the config lock, and logs the change (none when unchanged). */
export async function setWorkspacePipelinePaused(input: SetWorkspacePauseInput): Promise<WorkspacePauseChange> {
	const at = new Date((input.now ?? Date.now)()).toISOString();
	let changed = false;
	const settings = await updateWorkspacePipelineEntry(
		input.workspaceId,
		(entry) => {
			const pipeline = readObject(entry.pipeline);
			if ((pipeline.paused === true) === input.paused) {
				return entry;
			}
			changed = true;
			if (input.paused) {
				pipeline.paused = true;
				pipeline.pausedAt = at;
			} else {
				delete pipeline.paused;
				delete pipeline.pausedAt;
			}
			if (Object.keys(pipeline).length > 0) {
				entry.pipeline = pipeline;
			} else {
				delete entry.pipeline;
			}
			// A workspace that had no entry before the pause has none after the resume.
			return Object.keys(entry).length > 0 ? entry : null;
		},
		input.configPath,
	);
	const kitName = settings.kit?.name ?? DEFAULT_KIT_NAME;
	if (changed) {
		const reason = input.reason?.trim();
		await input.decisionLog.append([
			{
				at,
				workspaceId: input.workspaceId,
				taskId: null,
				stage: "pause",
				kit: kitName,
				landingMode: settings.landing.mode,
				shadow: settings.pipeline.shadow,
				effectiveAgent: null,
				model: null,
				role: null,
				answer: { by: input.by, paused: input.paused, reason: reason || null },
				outcome: "acted",
				note: input.paused
					? `QA pipeline paused by ${input.by}${reason ? ` (${reason})` : ""}: QA cards are queued in Backlog, none starts, nothing lands and no rework is sent until \`kanban pipeline resume\``
					: `QA pipeline resumed by ${input.by}${reason ? ` (${reason})` : ""}: queued QA cards start, PASSes land and reworks are sent again`,
			},
		]);
	}
	return {
		workspaceId: input.workspaceId,
		paused: settings.pipeline.paused,
		changed,
		pausedAt: settings.pipeline.paused ? settings.pipeline.pausedAt : null,
		landingMode: settings.landing.mode,
		kitName,
	};
}
