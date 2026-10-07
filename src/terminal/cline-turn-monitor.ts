// Ends a Cline CLI turn in Kanban when Cline's session files show it is over but no TaskComplete hook came
// (`agents.cline.turnDetector` in config.json, see cline-turn-detector-config.ts). Every tick it looks at the
// live card sessions whose adapter reads turn ends from session files and that Kanban still reports "running",
// and asks evaluateClineTurnEnd (cline-turn-outcome.ts). With mode "on" it ends the turn the way the hook does
// (`endTurn` = hooks ingest `to_review`: summary → awaiting_review, turn checkpoint, broadcasts), so session sync
// and the board stay agent-agnostic. With mode "report" it only logs each turn it would end, once.
//
// Ported from archive/devteam-kit:services/kanban-column-sync.mjs@acf45dce: the kit called hooks.ingest
// to_review from outside before moving the card, or an open web UI moved the "running" card straight back
// (calibration QA cards bounced every 5 min from 18:02Z 10/06). Not ported: the kit's rules for cards with no
// Kanban summary and for "<taskId>-…" session dirs; both were for the embedded Cline agent this fork removed.
import {
	type ClineTurnDetectorSettings,
	getDefaultClineTurnDetectorSettings,
} from "../config/cline-turn-detector-config";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { getAgentTurnEndSource } from "./agent-session-adapters";
import { type ClineSessionFileReader, createClineSessionFileReader } from "./cline-session-files";
import {
	type ClineTurnCheckSessions,
	describeClineTurnEnd,
	type EndedClineTurn,
	isLiveRunningCardSession,
	type LiveCardSessionSummary,
	readClineTurnEnd,
} from "./cline-turn-check";

export interface ClineTurnMonitorSessions extends ClineTurnCheckSessions {
	listSummaries: () => RuntimeTaskSessionSummary[];
}

export interface ClineTurnMonitorWorkspace {
	workspaceId: string;
	sessions: ClineTurnMonitorSessions;
}

export interface ClineTurnEndRequest {
	workspaceId: string;
	taskId: string;
	decision: EndedClineTurn;
}

export interface ClineTurnMonitorDependencies {
	listWorkspaces: () => ClineTurnMonitorWorkspace[];
	loadSettings: () => Promise<ClineTurnDetectorSettings>;
	endTurn: (request: ClineTurnEndRequest) => Promise<{ ok: boolean; error?: string }>;
	log: (message: string) => void;
	reader?: ClineSessionFileReader;
	now?: () => number;
}

export interface ClineTurnMonitorAction extends ClineTurnEndRequest {
	/** "ended": endTurn succeeded; "reported": mode "report"; "failed": endTurn failed. */
	outcome: "ended" | "reported" | "failed";
}

export interface ClineTurnMonitor {
	tick: () => Promise<ClineTurnMonitorAction[]>;
	start: () => void;
	close: () => void;
}

const DEFAULT_INTERVAL_SEC = getDefaultClineTurnDetectorSettings().intervalSec;

function isWatchedSession(summary: RuntimeTaskSessionSummary): summary is LiveCardSessionSummary {
	return isLiveRunningCardSession(summary) && getAgentTurnEndSource(summary.agentId) === "cline-session-files";
}

export function createClineTurnMonitor(deps: ClineTurnMonitorDependencies): ClineTurnMonitor {
	const reader = deps.reader ?? createClineSessionFileReader();
	const now = deps.now ?? Date.now;
	// "<workspaceId>:<taskId>" -> the reply last reported, so report mode logs each turn once.
	const reported = new Map<string, string>();
	let timer: NodeJS.Timeout | null = null;
	let closed = false;
	let running: Promise<ClineTurnMonitorAction[]> | null = null;

	const runTick = async (settings: ClineTurnDetectorSettings): Promise<ClineTurnMonitorAction[]> => {
		const actions: ClineTurnMonitorAction[] = [];
		if (settings.mode === "off") {
			reported.clear();
			return actions;
		}
		const watched = new Set<string>();
		for (const workspace of deps.listWorkspaces()) {
			for (const summary of workspace.sessions.listSummaries()) {
				if (!isWatchedSession(summary)) {
					continue;
				}
				const key = `${workspace.workspaceId}:${summary.taskId}`;
				watched.add(key);
				const decision = await readClineTurnEnd({
					reader,
					settings,
					sessions: workspace.sessions,
					summary,
					now: now(),
				});
				if (!decision.ended) {
					continue;
				}
				const request = { workspaceId: workspace.workspaceId, taskId: summary.taskId, decision };
				if (settings.mode === "report") {
					const replyKey = String(decision.replyAt);
					if (reported.get(key) !== replyKey) {
						reported.set(key, replyKey);
						deps.log(
							`[cline-turn-detector] report only: would end ${summary.taskId}'s turn (${describeClineTurnEnd(decision)}) in workspace ${workspace.workspaceId}`,
						);
					}
					actions.push({ ...request, outcome: "reported" });
					continue;
				}
				const result = await deps.endTurn(request).catch((error: unknown) => ({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}));
				if (result.ok) {
					deps.log(`[cline-turn-detector] ended ${summary.taskId}'s turn (${describeClineTurnEnd(decision)})`);
				} else {
					deps.log(
						`[cline-turn-detector] could not end ${summary.taskId}'s turn: ${result.error ?? "unknown error"}`,
					);
				}
				actions.push({ ...request, outcome: result.ok ? "ended" : "failed" });
			}
		}
		for (const key of reported.keys()) {
			if (!watched.has(key)) {
				reported.delete(key);
			}
		}
		return actions;
	};

	const tickWith = async (settings: ClineTurnDetectorSettings): Promise<ClineTurnMonitorAction[]> => {
		running ??= runTick(settings).finally(() => {
			running = null;
		});
		return await running;
	};

	const schedule = (delayMs: number): void => {
		if (closed) {
			return;
		}
		timer = setTimeout(() => {
			void loop();
		}, delayMs);
		timer.unref();
	};

	const loop = async (): Promise<void> => {
		let intervalSec = DEFAULT_INTERVAL_SEC;
		try {
			const settings = await deps.loadSettings();
			intervalSec = settings.intervalSec;
			await tickWith(settings);
		} catch (error) {
			deps.log(`[cline-turn-detector] tick failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			schedule(intervalSec * 1000);
		}
	};

	return {
		tick: async () => await tickWith(await deps.loadSettings()),
		start: () => {
			schedule(DEFAULT_INTERVAL_SEC * 1000);
		},
		close: () => {
			closed = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
