// The dev-assignment log for cards the browser creates (P5-1 follow-up). The browser builds a new card itself and
// saves the whole board, so the server is what logs it: `workspace.saveState` hands over the cards a save added
// (`saveWorkspaceStateReportingAddedCards`, compared under the board lock), and each new dev card gets one entry in
// `dev-assignment.jsonl` with the same shape `kanban task create` writes, plus `source: "browser"`.
//
// Guarantees:
//   - One entry per task id: a card already in the log (a re-save, a CLI card) is never logged again. Cards the CLI,
//     the pipeline, calibration or runoffs create are written with `mutateWorkspaceState`, so a browser save never
//     reports them as added.
//   - Only dev cards (`resolveCardRole()`), and only when the workspace's kit has a proposal: a `default`-kit board
//     never gets the file.
//   - `created.agentId` is the card's effective agent at creation (`resolveEffectiveAgent()`: the card's agent, else
//     the selected one), so a later change of the selected agent doesn't rewrite what the card was created on.
//   - The proposal is a fresh `resolveDevAssignment()`, the same answer the create dialog preselected. With an
//     `applied` proposal, a card still on it is logged `applied`, a card the user changed `explicit`.
import { loadGlobalRuntimeConfig } from "../config/runtime-config";
import type { RuntimeAgentId, RuntimeBoardCard } from "../core/api-contract";
import { resolveCardRole } from "../core/card-role";
import { resolveEffectiveAgent } from "../core/effective-agent";
import { cloneRuntimeTaskAgentSettings } from "../core/task-agent-settings";
import {
	type DevAssignmentDecision,
	type DevAssignmentLogEntry,
	type DevAssignmentProposal,
	readDevAssignmentLog,
	recordDevAssignment,
	resolveDevAssignment,
} from "./dev-assignment";

export interface BrowserDevAssignmentLogOptions {
	now?: Date;
	/** Default: the selected agent in the global runtime config, read only when a card is logged. */
	loadSelectedAgentId?: () => Promise<RuntimeAgentId>;
	configPath?: string;
	kitsDir?: string;
}

// Saves of one workspace are logged one after another, so two saves can't both miss each other's entry.
const pendingByWorkspace = new Map<string, Promise<unknown>>();

async function readLoggedTaskIds(workspaceId: string): Promise<Set<string>> {
	return new Set((await readDevAssignmentLog(workspaceId)).map((entry) => entry.taskId));
}

/** True while the card's agent and model are still exactly the kit's proposal (the dialog's preselection). */
export function isCardOnProposal(card: RuntimeBoardCard, proposal: DevAssignmentProposal): boolean {
	return (
		card.agentId === proposal.agentId &&
		(card.agentSettings?.modelId ?? undefined) === proposal.agentSettings?.modelId &&
		(card.agentSettings?.providerId ?? undefined) === proposal.agentSettings?.providerId
	);
}

async function logBrowserCard(
	workspaceId: string,
	card: RuntimeBoardCard,
	selectedAgentId: () => Promise<RuntimeAgentId>,
	options: BrowserDevAssignmentLogOptions,
): Promise<DevAssignmentLogEntry | null> {
	const resolved = await resolveDevAssignment(
		{ workspaceId, title: card.title, prompt: card.prompt },
		{ configPath: options.configPath, kitsDir: options.kitsDir },
	);
	const proposal = resolved.proposal;
	if (!proposal || (resolved.outcome !== "applied" && resolved.outcome !== "shadow")) {
		return null;
	}
	const outcome = resolved.outcome === "applied" && !isCardOnProposal(card, proposal) ? "explicit" : resolved.outcome;
	const decision: DevAssignmentDecision = {
		...resolved,
		outcome,
		agentId: resolveEffectiveAgent(card, null, { selectedAgentId: await selectedAgentId() }),
		agentSettings: cloneRuntimeTaskAgentSettings(card.agentSettings),
	};
	return await recordDevAssignment(decision, card, { now: options.now, source: "browser" });
}

async function logAddedCards(
	workspaceId: string,
	addedCards: readonly RuntimeBoardCard[],
	options: BrowserDevAssignmentLogOptions,
): Promise<DevAssignmentLogEntry[]> {
	const devCards = addedCards.filter((card) => resolveCardRole(card) === "dev");
	if (devCards.length === 0) {
		return [];
	}
	const logged = await readLoggedTaskIds(workspaceId);
	let selected: Promise<RuntimeAgentId> | null = null;
	const selectedAgentId = () => {
		selected ??=
			options.loadSelectedAgentId?.() ?? loadGlobalRuntimeConfig().then((config) => config.selectedAgentId);
		return selected;
	};
	const entries: DevAssignmentLogEntry[] = [];
	for (const card of devCards) {
		if (logged.has(card.id)) {
			continue;
		}
		const entry = await logBrowserCard(workspaceId, card, selectedAgentId, options);
		if (entry) {
			logged.add(card.id);
			entries.push(entry);
		}
	}
	return entries;
}

/** Logs the dev cards a browser board save added. Never throws: a failure only loses log lines, never the save. */
export async function recordBrowserDevAssignments(
	workspaceId: string,
	addedCards: readonly RuntimeBoardCard[],
	options: BrowserDevAssignmentLogOptions = {},
): Promise<DevAssignmentLogEntry[]> {
	const previous = pendingByWorkspace.get(workspaceId) ?? Promise.resolve();
	const settled = previous.then(() => logAddedCards(workspaceId, addedCards, options)).catch(() => []);
	pendingByWorkspace.set(workspaceId, settled);
	try {
		return await settled;
	} finally {
		if (pendingByWorkspace.get(workspaceId) === settled) {
			pendingByWorkspace.delete(workspaceId);
		}
	}
}
