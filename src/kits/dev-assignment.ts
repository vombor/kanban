// `devAssignment` at card creation (plan §4.0, P3-5): when the creator set no agent and no model, the workspace's
// resolved kit may name the agent and model a new dev card runs on, and the answer is stored on the card. Every
// creator goes through this module: `kanban task create` calls it in-process (the CLI writes the board itself), and
// the browser's create dialog asks `workspace.getDevAssignment` over tRPC to preselect the proposal.
//
// Guarantees:
//   - An explicit agent or model always wins (`--agent-id default` counts: it explicitly asks for the selected agent).
//   - The `default` kit answers null, so a board without a kit creates cards exactly as upstream does.
//   - With `workspaces.<id>.pipeline.shadow` on, the proposal is only logged; the card is created as today.
//   - Never decides on an agent id literal: the agent comes from the kit, and whether a provider is stored comes from
//     the agent catalog's capabilities.
//
// Proposals are logged to `data/<workspace>/dev-assignment.jsonl` whenever the kit has one (applied, shadow or
// overridden by the creator), so a shadow day can compare them with the orchestrator's own choices (P5-1). The CLI
// logs its cards itself; browser-created cards are logged by the server on board save
// (`browser-dev-assignment-log.ts`), with the same entry shape and `source: "browser"`.
//
// Reassignment (`kanban task reassign`, issue #14's side note): a card keeps what it was created with, so applying a
// kit later changes nothing for the Backlog, and clearing a card's agent (`task update --agent-id default`) leaves it
// on the selected agent, not on the kit. `decideDevReassignment()` asks the kit's current devAssignment again for a
// Backlog dev card that never started, as if the card were created now: a card with no agent and no model, or one
// still exactly on the kit's last logged `applied` assignment (an older kit's pick, not the user's), takes the current
// proposal; any other agent or model is the user's explicit pick and is kept. A reassignment is logged like a creation
// (`source: "reassign"`, with the card's `previous` agent).
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { getWorkspacePipelineSettings, type PipelineConfig, readPipelineConfig } from "../config/pipeline-config";
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeTaskAgentSettings,
} from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { cloneRuntimeTaskAgentSettings } from "../core/task-agent-settings";
import { providerForModel } from "../models/cline-providers";
import { getKanbanWorkspaceDataPath } from "../state/kanban-home";
import { createRoutingPolicy } from "./policy";
import { DEFAULT_KIT_NAME, loadKitCatalog, resolveWorkspaceKit, type WorkspaceKitResolution } from "./resolve-kit";
import { getStrictRoutingVetting, getWorkspaceRoutingVetting, type RoutingVetting } from "./routing-vetting";

export const DEV_ASSIGNMENT_LOG_FILENAME = "dev-assignment.jsonl";

export interface DevAssignmentRequest {
	workspaceId: string;
	title: string;
	prompt: string;
	/** The creator's agent: undefined = none set; null = explicitly the selected agent (`--agent-id default`). */
	agentId?: RuntimeAgentId | null;
	agentSettings?: RuntimeTaskAgentSettings;
}

/** What the kit proposes, as card fields. */
export interface DevAssignmentProposal {
	agentId: RuntimeAgentId;
	agentSettings?: RuntimeTaskAgentSettings;
	/** The kit tier the model came from (`dev.model: { tier }`), for display. */
	tier: string | null;
	/** The vetted model registry doesn't allow it for dev work: never applied (src/kits/routing-vetting.ts). */
	refused?: string;
}

export type DevAssignmentOutcome =
	/** The kit has no answer (the `default` kit): the card is created as the creator set it. */
	| "none"
	/** The creator set an agent or model: theirs wins. */
	| "explicit"
	/** `pipeline.shadow` is on: logged, not applied. */
	| "shadow"
	/** The kit's dev role is not allowed by the vetted model registry: not applied, the creator must choose. */
	| "refused"
	/** Stored on the card. */
	| "applied";

export interface DevAssignmentDecision {
	workspaceId: string;
	kitName: string;
	outcome: DevAssignmentOutcome;
	proposal: DevAssignmentProposal | null;
	/** The agent and settings to store on the card. Equal to the request's unless the outcome is `applied`. */
	agentId: RuntimeAgentId | undefined;
	agentSettings: RuntimeTaskAgentSettings | undefined;
	/** Kit resolution problems (the workspace then runs on `default`). */
	issues: string[];
}

/** True when the creator chose an agent or a model (a reasoning effort alone doesn't count). */
export function hasExplicitDevAssignment(request: Pick<DevAssignmentRequest, "agentId" | "agentSettings">): boolean {
	return (
		request.agentId !== undefined ||
		Boolean(request.agentSettings?.providerId?.trim()) ||
		Boolean(request.agentSettings?.modelId?.trim())
	);
}

/**
 * The provider stored with a proposed model: the kit's own, else the machine's `models.providers` policy
 * (`providerForModel`: `fallback[model]`, else `default`). Null for an agent that reads no provider.
 */
export function resolveProposalProvider(
	agentId: RuntimeAgentId,
	model: { provider: string | null; model: string },
	models: PipelineConfig["models"],
): string | null {
	if (getRuntimeAgentCatalogEntry(agentId)?.capabilities.providerOverride === "none") {
		return null;
	}
	return model.provider ?? providerForModel(model.model, models.providers);
}

/** Asks the resolved kit and turns its answer into card fields. Pure. */
export function proposeDevAssignment(input: {
	request: Pick<DevAssignmentRequest, "workspaceId" | "title" | "prompt">;
	resolved: Pick<WorkspaceKitResolution, "kit">;
	models: PipelineConfig["models"];
	vetting?: RoutingVetting;
}): DevAssignmentProposal | null {
	const answer = createRoutingPolicy(input.resolved.kit, input.vetting ?? getStrictRoutingVetting()).devAssignment({
		workspaceId: input.request.workspaceId,
		title: input.request.title,
		prompt: input.request.prompt,
		role: "dev",
	});
	if (!answer) {
		return null;
	}
	const refused = answer.refused ? { refused: answer.refused } : {};
	if (!answer.model) {
		return { agentId: answer.agentId, tier: answer.tier ?? null, ...refused };
	}
	const providerId = resolveProposalProvider(answer.agentId, answer.model, input.models);
	return {
		agentId: answer.agentId,
		agentSettings: { ...(providerId ? { providerId } : {}), modelId: answer.model.model },
		tier: answer.tier ?? null,
		...refused,
	};
}

/** Decides what a new card gets. Pure: `config` and `resolved` are the workspace's current settings and kit. */
export function decideDevAssignment(input: {
	request: DevAssignmentRequest;
	config: PipelineConfig;
	resolved: WorkspaceKitResolution;
}): DevAssignmentDecision {
	const { request, config, resolved } = input;
	const requested = {
		agentId: request.agentId ?? undefined,
		agentSettings: cloneRuntimeTaskAgentSettings(request.agentSettings),
	};
	const proposal = proposeDevAssignment({
		request,
		resolved,
		models: config.models,
		vetting: getWorkspaceRoutingVetting(config, request.workspaceId),
	});
	const base = { workspaceId: request.workspaceId, kitName: resolved.kitName, proposal, issues: resolved.issues };
	if (!proposal) {
		return { ...base, outcome: "none", ...requested };
	}
	if (hasExplicitDevAssignment(request)) {
		return { ...base, outcome: "explicit", ...requested };
	}
	if (proposal.refused) {
		return { ...base, outcome: "refused", ...requested };
	}
	if (getWorkspacePipelineSettings(config, request.workspaceId).pipeline.shadow) {
		return { ...base, outcome: "shadow", ...requested };
	}
	// A reasoning effort the creator set alone is kept with the kit's model.
	const reasoningEffort = requested.agentSettings?.reasoningEffort;
	const agentSettings =
		proposal.agentSettings || reasoningEffort
			? { ...proposal.agentSettings, ...(reasoningEffort ? { reasoningEffort } : {}) }
			: undefined;
	return { ...base, outcome: "applied", agentId: proposal.agentId, agentSettings };
}

/** The workspace's current settings and kit, which every devAssignment decision reads. */
export interface DevAssignmentContext {
	config: PipelineConfig;
	resolved: WorkspaceKitResolution;
	/** config.json and kit resolution problems (the workspace then runs on `default`). */
	issues: string[];
}

export interface DevAssignmentContextOptions {
	configPath?: string;
	kitsDir?: string;
}

/** Reads config.json and the kit catalog and resolves the workspace's kit. Throws when config.json can't be read. */
export async function loadDevAssignmentContext(
	workspaceId: string,
	options: DevAssignmentContextOptions = {},
): Promise<DevAssignmentContext> {
	const [{ config, issues }, catalog] = await Promise.all([
		readPipelineConfig(options.configPath),
		loadKitCatalog(options.kitsDir),
	]);
	const resolved = resolveWorkspaceKit(config, workspaceId, catalog);
	return { config, resolved, issues: [...issues, ...resolved.issues] };
}

/**
 * Reads the workspace's config and kit, then decides. A config.json that can't be read decides nothing (`none`,
 * with an issue): routing must never stop a card from being created.
 */
export async function resolveDevAssignment(
	request: DevAssignmentRequest,
	options: DevAssignmentContextOptions = {},
): Promise<DevAssignmentDecision> {
	try {
		const context = await loadDevAssignmentContext(request.workspaceId, options);
		const decision = decideDevAssignment({ request, config: context.config, resolved: context.resolved });
		return { ...decision, issues: context.issues };
	} catch (error) {
		return {
			workspaceId: request.workspaceId,
			kitName: DEFAULT_KIT_NAME,
			outcome: "none",
			proposal: null,
			agentId: request.agentId ?? undefined,
			agentSettings: cloneRuntimeTaskAgentSettings(request.agentSettings),
			issues: [`could not read the kit config: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
}

/** What `decideDevReassignment()` did with a card. */
export type DevReassignmentStatus =
	/** The card takes the kit's current proposal. */
	| "reassigned"
	/** The card is already on the kit's current proposal. */
	| "unchanged"
	/** The card names an agent or model that isn't the kit's: the user's pick, kept. */
	| "explicit"
	/** `pipeline.shadow` is on: the proposal is logged, not applied. */
	| "shadow"
	/**
	 * The kit's dev role is a combination the vetted model registry doesn't allow (`proposal.refused` says why): the
	 * card is left as it is, as task create refuses it.
	 */
	| "refused"
	/** The kit has no dev assignment (the `default` kit): the card keeps running on the selected agent. */
	| "no_proposal"
	/** Not in Backlog: a started card's agent never changes. */
	| "not_backlog"
	/** In Backlog, but it has run before (it has a session summary). */
	| "started"
	/** Not a dev card (`resolveCardRole()`): devAssignment never answers for it. */
	| "not_dev";

export interface DevReassignment {
	taskId: string;
	status: DevReassignmentStatus;
	/** Null when the card was skipped before the kit was asked (`not_backlog`, `started`, `not_dev`). */
	decision: DevAssignmentDecision | null;
}

type CardAgentChoice = Pick<RuntimeBoardCard, "agentId" | "agentSettings">;

function isSameAgentChoice(
	card: CardAgentChoice,
	other: { agentId?: RuntimeAgentId | null; agentSettings?: RuntimeTaskAgentSettings | null },
): boolean {
	return (
		(card.agentId ?? null) === (other.agentId ?? null) &&
		(card.agentSettings?.providerId ?? null) === (other.agentSettings?.providerId ?? null) &&
		(card.agentSettings?.modelId ?? null) === (other.agentSettings?.modelId ?? null)
	);
}

/**
 * True when the card's agent is the kit's, not the user's: it names no agent and no model (it inherits), or it is
 * still exactly what the kit applied when the card was last logged (`lastLogged`, its newest log entry).
 */
export function isKitOwnedAgentChoice(card: CardAgentChoice, lastLogged: DevAssignmentLogEntry | null): boolean {
	if (!hasExplicitDevAssignment(card)) {
		return true;
	}
	return lastLogged?.outcome === "applied" && isSameAgentChoice(card, lastLogged.created);
}

/**
 * Decides what an existing card gets from the kit's current devAssignment (`kanban task reassign`). Pure: run it on
 * the board read under the workspace lock, so a card started meanwhile is never changed.
 */
export function decideDevReassignment(input: {
	workspaceId: string;
	card: RuntimeBoardCard;
	columnId: RuntimeBoardColumnId;
	/** True when the card has a session summary: it has run, even if it is back in Backlog. */
	hasSession: boolean;
	lastLogged: DevAssignmentLogEntry | null;
	context: Pick<DevAssignmentContext, "config" | "resolved">;
}): DevReassignment {
	const { card } = input;
	const skipped = (status: DevReassignmentStatus): DevReassignment => ({ taskId: card.id, status, decision: null });
	if (input.columnId !== "backlog") {
		return skipped("not_backlog");
	}
	if (input.hasSession) {
		return skipped("started");
	}
	if (resolveCardRole(card) !== "dev") {
		return skipped("not_dev");
	}
	const kitOwned = isKitOwnedAgentChoice(card, input.lastLogged);
	// A kit-owned card is asked as if it were created now with nothing set; only its own reasoning effort is kept.
	const reasoningEffort = card.agentSettings?.reasoningEffort;
	const decision = decideDevAssignment({
		request: {
			workspaceId: input.workspaceId,
			title: card.title,
			prompt: card.prompt,
			agentId: kitOwned ? undefined : card.agentId,
			agentSettings: kitOwned ? (reasoningEffort ? { reasoningEffort } : undefined) : card.agentSettings,
		},
		config: input.context.config,
		resolved: input.context.resolved,
	});
	const status: DevReassignmentStatus =
		decision.outcome === "none"
			? "no_proposal"
			: decision.outcome === "applied"
				? isSameAgentChoice(card, decision)
					? "unchanged"
					: "reassigned"
				: decision.outcome;
	return { taskId: card.id, status, decision };
}

/**
 * Who created the card: `kanban task create`, the browser's create dialog (logged by the server on save), or the
 * issue import (src/issues/issue-apply.ts); `reassign` is `kanban task reassign` on an existing card.
 */
export type DevAssignmentLogSource = "cli" | "browser" | "issues" | "reassign";

export interface DevAssignmentLogEntry {
	at: string;
	workspaceId: string;
	taskId: string;
	title: string;
	kit: string;
	outcome: Exclude<DevAssignmentOutcome, "none">;
	proposal: DevAssignmentProposal;
	/** What the card was created with (for `source: "reassign"`: what it has now). */
	created: { agentId: RuntimeAgentId | null; agentSettings: RuntimeTaskAgentSettings | null };
	/** Only for `source: "reassign"`: what the card had before. */
	previous?: { agentId: RuntimeAgentId | null; agentSettings: RuntimeTaskAgentSettings | null };
	/** Missing on entries written before browser cards were logged (all of those came from the CLI). */
	source?: DevAssignmentLogSource;
}

export function getDevAssignmentLogPath(workspaceId: string): string {
	return join(getKanbanWorkspaceDataPath(workspaceId), DEV_ASSIGNMENT_LOG_FILENAME);
}

/**
 * Appends the decision for a created card to `data/<workspace>/dev-assignment.jsonl`. Nothing is written when the
 * kit had no proposal, so boards on the `default` kit never get the file.
 */
export async function recordDevAssignment(
	decision: DevAssignmentDecision,
	task: { id: string; title: string },
	options: {
		now?: Date;
		dataDir?: string;
		source?: DevAssignmentLogSource;
		/** For `source: "reassign"`: the card's agent before. */
		previous?: CardAgentChoice;
	} = {},
): Promise<DevAssignmentLogEntry | null> {
	if (!decision.proposal || decision.outcome === "none") {
		return null;
	}
	const entry: DevAssignmentLogEntry = {
		at: (options.now ?? new Date()).toISOString(),
		workspaceId: decision.workspaceId,
		taskId: task.id,
		title: task.title,
		kit: decision.kitName,
		outcome: decision.outcome,
		proposal: decision.proposal,
		created: { agentId: decision.agentId ?? null, agentSettings: decision.agentSettings ?? null },
		source: options.source ?? "cli",
		...(options.previous
			? {
					previous: {
						agentId: options.previous.agentId ?? null,
						agentSettings: cloneRuntimeTaskAgentSettings(options.previous.agentSettings) ?? null,
					},
				}
			: {}),
	};
	const dataDir = options.dataDir ?? getKanbanWorkspaceDataPath(decision.workspaceId);
	await mkdir(dataDir, { recursive: true });
	await appendFile(join(dataDir, DEV_ASSIGNMENT_LOG_FILENAME), `${JSON.stringify(entry)}\n`, "utf8");
	return entry;
}

/** The workspace's dev-assignment log, oldest first. A missing file is empty; a torn line is skipped. */
export async function readDevAssignmentLog(
	workspaceId: string,
	options: { dataDir?: string } = {},
): Promise<DevAssignmentLogEntry[]> {
	const dataDir = options.dataDir ?? getKanbanWorkspaceDataPath(workspaceId);
	let text: string;
	try {
		text = await readFile(join(dataDir, DEV_ASSIGNMENT_LOG_FILENAME), "utf8");
	} catch {
		return [];
	}
	const entries: DevAssignmentLogEntry[] = [];
	for (const line of text.split("\n")) {
		try {
			const entry: unknown = line.trim() ? JSON.parse(line) : null;
			if (entry && typeof entry === "object" && typeof (entry as { taskId?: unknown }).taskId === "string") {
				entries.push(entry as DevAssignmentLogEntry);
			}
		} catch {
			// A torn line is skipped, as the shadow diff's reader does.
		}
	}
	return entries;
}

/** Each card's newest log entry. */
export function latestDevAssignmentByTask(
	entries: readonly DevAssignmentLogEntry[],
): Map<string, DevAssignmentLogEntry> {
	const latest = new Map<string, DevAssignmentLogEntry>();
	for (const entry of entries) {
		latest.set(entry.taskId, entry);
	}
	return latest;
}
