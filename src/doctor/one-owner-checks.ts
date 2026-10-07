// `kanban doctor`'s "one owner" check (plan §8.2): every responsibility has exactly one owner at any time. While the
// legacy kit runs, each runtime feature ships off or in shadow and is switched on per workspace in the same step that
// switches the kit's service or toggle off. This reports a responsibility both own (FAIL), and where the two
// configs disagree about who owns it. Rows exist only for runtime features that exist: landing (vs autoland),
// column moves (session sync vs column-sync), ending Cline CLI turns (the turn detector vs column-sync) and the
// Lemonade model list. Kanban's landing step (P4-4) is in the landing rows, the watchdog (P4-7) has its row vs
// review-watch, and recovery (P4-6: nudges, provider retries, restart resumes) its row vs autoland. The rest of the
// pipeline (P4-x) adds theirs when it lands.

import {
	findImplicitLegacyToggleWarnings,
	getLegacyKitRunPath,
	type LegacyKitConfigFile,
	type LegacyKitService,
	legacyKitServiceOwns,
	listLegacyKitProjects,
} from "../config/legacy-kit-config";
import { getWorkspacePipelineSettings, type PipelineConfig } from "../config/pipeline-config";
import type { RuntimeBoardData } from "../core/api-contract";
import { getRecoveryScope } from "../pipeline/engine";
import { isLegacyModelListsServiceUrl, isManagedModelsSourceUrl } from "../setup/cline-models-source";
import type { RuntimeWorkspaceIndexEntry } from "../state/workspace-state";
import type { DoctorFinding } from "./doctor-report";

export interface OneOwnerContext {
	legacyKit: LegacyKitConfigFile;
	services: LegacyKitService[];
	config: PipelineConfig;
	entries: RuntimeWorkspaceIndexEntry[];
	loadBoard: (workspaceId: string) => Promise<RuntimeBoardData | null>;
	/** Cline's current Lemonade `modelsSourceUrl`, or null when it has none. */
	clineModelsSourceUrl: string | null;
}

const OPEN_COLUMNS = new Set(["backlog", "in_progress", "review"]);
const MAX_LISTED_CARDS = 8;

function describeService(service: LegacyKitService): string {
	if (service.pid !== null) {
		return `${service.name} running (pid ${service.pid})${service.disabled ? " though disabled" : ""}`;
	}
	return `${service.name} ${service.disabled ? "disabled" : "not running (restarted by review-watch / the bashrc hook)"}`;
}

export async function checkOneOwner(context: OneOwnerContext): Promise<DoctorFinding[]> {
	const { legacyKit } = context;
	if (legacyKit.error) {
		return [
			{
				level: "warn",
				area: "owner",
				message: `legacy kit config ${legacyKit.path} can't be read (${legacyKit.error}); can't tell what it owns`,
			},
		];
	}
	if (!legacyKit.raw) {
		return [
			{ level: "pass", area: "owner", message: `no legacy kit (${legacyKit.path} absent): Kanban owns everything` },
			...checkColumnMoveOwners(context.config, { columnSyncOwns: false, kitInstalled: false, runPath: null }),
			...checkWatchdogOwner(context.config, { reviewWatchOwns: false, runPath: null }),
			...checkRecoveryOwners(context.config, context.entries, { autolandOwns: false, projects: [], runPath: null }),
		];
	}
	const columnSyncOwns = legacyKitServiceOwns(
		context.services.find((entry) => entry.name === "column-sync"),
		true,
	);
	return [
		...(await checkLegacyKitOwners(context, legacyKit.raw)),
		...checkColumnMoveOwners(context.config, {
			columnSyncOwns,
			kitInstalled: true,
			runPath: getLegacyKitRunPath(legacyKit.raw),
		}),
		...checkWatchdogOwner(context.config, {
			reviewWatchOwns: legacyKitServiceOwns(
				context.services.find((entry) => entry.name === "review-watch"),
				true,
			),
			runPath: getLegacyKitRunPath(legacyKit.raw),
		}),
		...checkRecoveryOwners(context.config, context.entries, {
			autolandOwns: legacyKitServiceOwns(
				context.services.find((entry) => entry.name === "autoland"),
				true,
			),
			projects: listLegacyKitProjects(legacyKit.raw).map((project) => project.workspaceId),
			runPath: getLegacyKitRunPath(legacyKit.raw),
		}),
	];
}

/**
 * Stall detection, ATTENTION.md, orchestrator wakes, PID pressure and prune-done. The legacy kit's review-watch does
 * them (archive/devteam-kit:services/review-watch.mjs); in Kanban it is the watchdog (P4-7, `watchdog.mode`, "off" by
 * default). Both on means two writers of ATTENTION.md and two wakes for every item. "report" only logs, so it can run
 * beside review-watch for the cutover comparison.
 */
export function checkWatchdogOwner(
	config: PipelineConfig,
	kit: { reviewWatchOwns: boolean; runPath: string | null },
): DoctorFinding[] {
	const mode = config.watchdog.mode;
	const retire = kit.runPath
		? `touch ${kit.runPath}/review-watch.disabled && kit stop review-watch`
		: "switch the legacy kit's review-watch off";
	if (mode === "on" && kit.reviewWatchOwns) {
		return [
			{
				level: "fail",
				area: "owner",
				message:
					"two owners for stall detection, ATTENTION.md and orchestrator wakes: Kanban's watchdog (watchdog.mode on) and the legacy kit's review-watch",
				hint: `${retire}, or set watchdog.mode to "report" in config.json`,
			},
		];
	}
	if (kit.reviewWatchOwns) {
		return [
			{
				level: "info",
				area: "owner",
				message: `the legacy kit's review-watch watches the boards and wakes the orchestrator; Kanban's watchdog is ${mode}${mode === "report" ? " (logs to data/<workspace>/watchdog-decisions.jsonl only)" : ""}`,
			},
		];
	}
	if (mode === "on") {
		return [
			{ level: "pass", area: "owner", message: "Kanban's watchdog watches the boards and wakes the orchestrator" },
		];
	}
	return [
		{
			level: "info",
			area: "owner",
			message: `nothing wakes the orchestrator or writes ATTENTION.md: no review-watch runs and watchdog.mode is ${mode}`,
			hint: 'set watchdog.mode to "on" in config.json',
		},
	];
}

/**
 * Column moves and Cline CLI turn ends. The legacy kit's column-sync does both: it moves cards In Progress ↔ Review
 * from Kanban's session state, and ends a Cline CLI turn that never fired TaskComplete (`hooks.ingest to_review`,
 * archive/devteam-kit:services/kanban-column-sync.mjs@acf45dc). In Kanban they are session sync (P2-1,
 * `sessionSync.enabled`, read at server start) and the Cline turn detector (P2-2,
 * `agents.cline.turnDetector.mode`, "report" by default while column-sync runs).
 */
export function checkColumnMoveOwners(
	config: PipelineConfig,
	kit: { columnSyncOwns: boolean; kitInstalled: boolean; runPath: string | null },
): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	const retireColumnSync = kit.runPath
		? `touch ${kit.runPath}/column-sync.disabled && kit stop column-sync`
		: "switch the legacy kit's column-sync off";
	const sessionSync = config.sessionSync.enabled;
	if (sessionSync && kit.columnSyncOwns) {
		findings.push({
			level: "fail",
			area: "owner",
			message:
				"two owners for In Progress ↔ Review moves: Kanban's session sync (sessionSync.enabled, from the next server start) and the legacy kit's column-sync",
			hint: `${retireColumnSync}, or set "sessionSync": { "enabled": false } in config.json`,
		});
	} else if (kit.columnSyncOwns) {
		findings.push({
			level: "info",
			area: "owner",
			message:
				"the legacy kit's column-sync moves cards between In Progress and Review; Kanban's session sync is off",
		});
	} else if (sessionSync) {
		findings.push({
			level: "pass",
			area: "owner",
			message: "Kanban's session sync moves cards between In Progress and Review",
		});
	} else {
		findings.push({
			level: "info",
			area: "owner",
			message:
				"session sync is off and no column-sync runs: only an open browser moves cards between In Progress and Review",
		});
	}

	const mode = config.agents.cline.turnDetector.mode;
	if (mode === "on" && kit.columnSyncOwns) {
		findings.push({
			level: "fail",
			area: "owner",
			message:
				"two owners for ending Cline CLI turns: the turn detector (agents.cline.turnDetector.mode on) and the legacy kit's column-sync",
			hint: `set agents.cline.turnDetector.mode to "report" until column-sync is retired (${retireColumnSync})`,
		});
	} else if (mode === "on" || kit.columnSyncOwns) {
		findings.push({
			level: "pass",
			area: "owner",
			message: `Cline CLI turns are ended by ${mode === "on" ? "the turn detector" : `the legacy kit's column-sync (turn detector: ${mode})`}`,
		});
	} else {
		findings.push({
			// While the kit is installed this is the gap a retired column-sync leaves; without it, a plain default.
			level: kit.kitInstalled ? "warn" : "info",
			area: "owner",
			message: `nothing ends a Cline CLI turn that never fires TaskComplete: no column-sync runs and agents.cline.turnDetector.mode is ${mode}`,
			hint: 'set agents.cline.turnDetector.mode to "on" in config.json',
		});
	}
	return findings;
}

/**
 * Recovery: crash nudges, premature-stop continues, provider retries and outage holds, hung-request cancels, and
 * resuming cards a restart orphaned. The legacy kit's autoland does all of it for every project it watches
 * (archive/devteam-kit:services/kanban-autoland.mjs@6da71597 nudgeIfErrored, checkRestart). In Kanban it is the
 * pipeline's recovery stage (`pipeline.recovery.mode`, "report" by default: decide and log only), which acts on a
 * workspace with mode "on", `workspaces.<id>.recovery.enabled` and no `pipeline.shadow`. Both acting would send
 * every nudge twice and start two sessions per orphan.
 */
export function checkRecoveryOwners(
	config: PipelineConfig,
	entries: RuntimeWorkspaceIndexEntry[],
	kit: { autolandOwns: boolean; projects: string[]; runPath: string | null },
): DoctorFinding[] {
	const mode = config.pipeline.recovery.mode;
	const kitProjects = new Set(kit.projects);
	const acting = entries
		.map((entry) => entry.workspaceId)
		.filter((workspaceId) => getRecoveryScope(config, getWorkspacePipelineSettings(config, workspaceId)).act);
	const both = kit.autolandOwns ? acting.filter((workspaceId) => kitProjects.has(workspaceId)) : [];
	if (both.length > 0) {
		return [
			{
				level: "fail",
				area: "owner",
				message: `two owners for recovery (nudges, provider retries, restart resumes) on ${both.join(", ")}: Kanban (pipeline.recovery.mode on) and the legacy kit's autoland`,
				hint: `set pipeline.recovery.mode to "report" (or workspaces.<id>.recovery.enabled false) until autoland is retired${kit.runPath ? ` (touch ${kit.runPath}/autoland.disabled && kit stop autoland)` : ""}`,
			},
		];
	}
	if (acting.length > 0) {
		return [
			{
				level: "pass",
				area: "owner",
				message: `Kanban recovers crashed and orphaned cards on ${acting.join(", ")} (pipeline.recovery.mode on)`,
			},
		];
	}
	if (kit.autolandOwns) {
		return [
			{
				level: "info",
				area: "owner",
				message: `the legacy kit's autoland recovers crashed and orphaned cards; Kanban's recovery is ${mode === "off" ? "off" : `${mode} (decides and logs only)`}`,
			},
		];
	}
	return [
		{
			level: kit.projects.length > 0 ? "warn" : "info",
			area: "owner",
			message: `nothing nudges crashed cards or resumes cards a restart orphaned: pipeline.recovery.mode is ${mode}${kit.projects.length > 0 ? " and the legacy kit's autoland is not running" : ""}`,
			hint: 'set pipeline.recovery.mode to "on" in config.json',
		},
	];
}

async function checkLegacyKitOwners(
	context: OneOwnerContext,
	raw: NonNullable<LegacyKitConfigFile["raw"]>,
): Promise<DoctorFinding[]> {
	const { legacyKit } = context;
	const findings: DoctorFinding[] = [
		{
			level: "info",
			area: "owner",
			message: `legacy kit ${legacyKit.path}: ${context.services.map(describeService).join(", ")}`,
		},
	];
	for (const warning of findImplicitLegacyToggleWarnings(raw)) {
		findings.push({
			level: "warn",
			area: "owner",
			message: `legacy kit: ${warning}`,
			hint: `edit ${legacyKit.path}`,
		});
	}

	const service = (name: LegacyKitService["name"]) => context.services.find((entry) => entry.name === name);
	const autolandOwns = legacyKitServiceOwns(service("autoland"), true);
	const registered = new Set(context.entries.map((entry) => entry.workspaceId));
	for (const project of listLegacyKitProjects(raw)) {
		const kitToggles = (Object.keys(project.toggles) as Array<keyof typeof project.toggles>).filter(
			(name) => project.toggles[name],
		);
		const kitLands = autolandOwns && (project.toggles.QA_CREATE || project.toggles.AUTO_DONE);
		const settings = getWorkspacePipelineSettings(context.config, project.workspaceId);
		const kanbanMode = settings.landing.mode;
		const kanbanKit = settings.kit?.name ?? "default";
		if (kitLands && kanbanMode !== "off" && !settings.pipeline.shadow) {
			findings.push({
				level: "fail",
				area: "owner",
				message: `two owners for landing on ${project.workspaceId}: the legacy kit (${kitToggles.join(", ")}) and Kanban (landing ${kanbanMode})`,
				hint: `switch one off: kanban kit apply ${kanbanKit} --project ${project.workspaceId} --landing off, or the project's toggles in ${legacyKit.path}`,
			});
		} else if (kitLands && kanbanMode !== "off") {
			findings.push({
				level: "info",
				area: "owner",
				message: `${project.workspaceId}: the legacy kit lands; Kanban shadows it (landing ${kanbanMode}, kit ${kanbanKit}, pipeline.shadow)`,
			});
		} else if (autolandOwns && kanbanMode === "qa" && !settings.pipeline.shadow) {
			// Autoland lands every Review → Done of a configured project whatever its toggles, from the trashed
			// task patch (archive/devteam-kit:services/kanban-autoland.mjs@6da71597, onReviewToDone). Kanban's
			// landing step (src/server/task-landing-gate.ts) lands before that Done, so the work would land twice.
			findings.push({
				level: "fail",
				area: "owner",
				message: `two owners for landing on ${project.workspaceId}: Kanban lands before Done (landing qa) and the legacy kit's autoland lands every Review → Done of a configured project`,
				hint: `remove ${project.workspaceId} from the legacy kit's projects in ${legacyKit.path}, or kanban kit apply ${kanbanKit} --project ${project.workspaceId} --landing off`,
			});
		} else if (kitLands) {
			findings.push({
				level: "info",
				area: "owner",
				message: `${project.workspaceId}: the legacy kit lands (${kitToggles.join(", ")}); Kanban's config has landing off, kit ${kanbanKit} for it`,
				hint: "kanban config import-kit --dry-run (maps it to a kit, in shadow)",
			});
		}
		if (!registered.has(project.workspaceId)) {
			findings.push({
				level: "warn",
				area: "owner",
				message: `legacy kit project ${project.workspaceId}${project.projectPath ? ` (${project.projectPath})` : ""} is not a Kanban project on this home`,
			});
			continue;
		}
		if (autolandOwns && project.toggles.AUTO_DONE) {
			// The kit lands after QA; a card with Kanban's own auto-review on would be committed by its agent too
			// ("Turn Kanban's own auto-review OFF on tasks handled by this, or both will try to land",
			// archive/devteam-kit:services/kanban-autoland.mjs@16879d1).
			const board = await context.loadBoard(project.workspaceId);
			const cards = (board?.columns ?? [])
				.filter((column) => OPEN_COLUMNS.has(column.id))
				.flatMap((column) => column.cards)
				.filter((card) => card.autoReviewEnabled === true);
			if (cards.length > 0) {
				const listed = cards
					.slice(0, MAX_LISTED_CARDS)
					.map((card) => `${card.id} (${card.autoReviewMode ?? "commit"})`)
					.join(", ");
				findings.push({
					level: "fail",
					area: "owner",
					message: `${project.workspaceId}: ${cards.length} card(s) have Kanban auto-review on while the legacy kit lands them after QA, so they would land twice: ${listed}${cards.length > MAX_LISTED_CARDS ? ", …" : ""}`,
					hint: "turn auto-review off on those cards",
				});
			}
		}
	}

	const modelListsOwns = legacyKitServiceOwns(service("model-lists"), true);
	const url = context.clineModelsSourceUrl;
	if (url && isLegacyModelListsServiceUrl(url)) {
		if (service("model-lists")?.pid === null) {
			findings.push({
				level: "fail",
				area: "owner",
				message: `Cline's Lemonade model list points at the legacy model-lists service (${url}), which is not running`,
				hint: "kanban setup (points it at Kanban's model-lists route)",
			});
		} else {
			findings.push({
				level: "info",
				area: "owner",
				message: `Cline's Lemonade model list comes from the legacy model-lists service (${url})`,
				hint: "kanban setup (moves it to Kanban's route), then retire the service",
			});
		}
	} else if (url && isManagedModelsSourceUrl(url) && modelListsOwns) {
		findings.push({
			level: "warn",
			area: "owner",
			message:
				"Cline's Lemonade model list comes from Kanban's route, but the legacy model-lists service is still on",
			hint: `touch ${getLegacyKitRunPath(raw)}/model-lists.disabled && kit stop model-lists`,
		});
	}
	return findings;
}
