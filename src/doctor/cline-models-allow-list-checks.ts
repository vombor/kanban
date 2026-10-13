// Doctor row: Cline's models.json is the allow list (docs/team/MODELS.md). A provider with an entry there offers only
// the models in its `models` record, so a kit role (roles, QA routes, the fallback, runoff models) or a card that puts
// a Cline card on a model its provider's record doesn't have is a warning: Cline couldn't select that model. Nothing
// more: Kanban refuses no model on any role, and the record is the user's to curate (never --fix).
// A provider without an entry in models.json (Cline's built-in ones: bedrock, cline-pass, ...) has no record here,
// so it isn't checked; non-Cline agents get no model check at all.
import type { PipelineConfig } from "../config/pipeline-config";
import type { RuntimeAgentId, RuntimeBoardData } from "../core/api-contract";
import { listKitRoutes } from "../kits/kit-routes";
import { type KitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { readClineModelRecords } from "../models/cline-model-records";
import { providerForModel } from "../models/cline-providers";
import { agentReadsClineModelsFile } from "../terminal/agent-session-adapters";
import type { DoctorFinding } from "./doctor-report";

const MAX_LISTED_CARDS = 5;

export interface ClineModelsAllowListCheckContext {
	config: PipelineConfig;
	catalog: KitCatalog;
	entries: ReadonlyArray<{ workspaceId: string }>;
	modelsPath: string;
	/** The agent selected in Kanban settings: what a card without an agent runs on. */
	selectedAgentId: RuntimeAgentId;
	/** The workspace's board; null when it can't be read (its cards are then not checked). */
	loadBoard: (workspaceId: string) => Promise<RuntimeBoardData | null>;
}

interface ModelUse {
	agentId: RuntimeAgentId;
	provider: string | null;
	model: string | null;
}

/** The provider and model a Cline card would ask for, when its provider's record doesn't list the model. */
function findMissingModel(
	use: ModelUse,
	records: ReadonlyMap<string, ReadonlySet<string>>,
	config: PipelineConfig,
): { provider: string; model: string } | null {
	const model = use.model?.trim();
	if (!model || !agentReadsClineModelsFile(use.agentId)) {
		return null;
	}
	const provider = use.provider?.trim() || providerForModel(model, config.models.providers);
	const record = records.get(provider);
	return record && !record.has(model) ? { provider, model } : null;
}

function hintFor(provider: string, modelsPath: string): string {
	return `pick a model in ${modelsPath}'s ${provider} record (kanban kit set roles.<role>.model ... / kanban task update ...), or ask the user to add it there once it passed kanban models vet`;
}

export async function checkClineModelsAllowList(context: ClineModelsAllowListCheckContext): Promise<DoctorFinding[]> {
	const records = await readClineModelRecords(context.modelsPath);
	if (!records || records.size === 0) {
		return [];
	}
	const findings: DoctorFinding[] = [];
	for (const { workspaceId } of context.entries) {
		const resolution = resolveWorkspaceKit(context.config, workspaceId, context.catalog);
		for (const route of listKitRoutes(resolution.kit)) {
			const missing = findMissingModel(route.combination, records, context.config);
			if (missing) {
				findings.push({
					level: "warn",
					area: "project",
					message: `${workspaceId}: kit ${resolution.kitLabel} ${route.label} puts Cline cards on ${missing.provider} + ${missing.model}, which ${missing.provider}'s models record in Cline's models.json doesn't list, so Cline couldn't select it`,
					hint: hintFor(missing.provider, context.modelsPath),
				});
			}
		}
		const board = await context.loadBoard(workspaceId);
		const cards = (board?.columns ?? [])
			.filter((column) => column.id !== "trash")
			.flatMap((column) => column.cards)
			.flatMap((card) => {
				const missing = findMissingModel(
					{
						agentId: card.agentId ?? context.selectedAgentId,
						provider: card.agentSettings?.providerId ?? null,
						model: card.agentSettings?.modelId ?? null,
					},
					records,
					context.config,
				);
				return missing ? [{ id: card.id, ...missing }] : [];
			});
		if (cards.length > 0) {
			const listed = cards
				.slice(0, MAX_LISTED_CARDS)
				.map((card) => `${card.id} (${card.provider} + ${card.model})`)
				.join(", ");
			findings.push({
				level: "warn",
				area: "project",
				message: `${workspaceId}: ${cards.length} card(s) run Cline on a model their provider's record in Cline's models.json doesn't list, so Cline couldn't select it: ${listed}${cards.length > MAX_LISTED_CARDS ? ", …" : ""}`,
				hint: hintFor(cards[0]?.provider ?? "the provider", context.modelsPath),
			});
		}
	}
	return findings;
}
