// Creating a plan card: the kit's plan routing (plan-assignment.ts), the plan prompt around the user's requirement
// (plan-prompt.ts), a slug for its spec files that no other plan of the workspace uses, and its plan index entry.
// `kanban task create --role plan` is the creator; a plan card the browser makes by hand has no index entry, and
// `kanban plan` then reads its slug from the prompt.
import type { RuntimeAgentId, RuntimeTaskAgentSettings } from "../core/api-contract";
import { resolvePlanAssignment } from "../kits/plan-assignment";
import { buildPlanPrompt } from "../kits/plan-prompt";
import { planSlugSchema, slugifyPlanTitle } from "./plan-breakdown";
import { chooseUniquePlanSlug, type PlanIndexStore, type PlanRecord } from "./plan-index";

export interface PreparePlanCardInput {
	workspaceId: string;
	title?: string;
	/** The user's business requirement (the card's `--prompt`). */
	requirement: string;
	/** `--plan-slug`; default from the title. */
	slug?: string;
	agentId?: RuntimeAgentId | null;
	agentSettings?: RuntimeTaskAgentSettings;
	startInPlanMode?: boolean;
}

export interface PreparedPlanCard {
	kitName: string;
	outcome: "applied" | "explicit";
	title: string;
	prompt: string;
	slug: string;
	agentId: RuntimeAgentId | undefined;
	agentSettings: RuntimeTaskAgentSettings | undefined;
	startInPlanMode: boolean;
	issues: string[];
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0]?.trim() ?? "";
}

/** The plan card's fields. Throws when the project's kit makes no plan cards or the slug is invalid. */
export async function preparePlanCard(
	input: PreparePlanCardInput,
	options: { index: PlanIndexStore; configPath?: string; kitsDir?: string },
): Promise<PreparedPlanCard> {
	if (!input.requirement.trim()) {
		throw new Error("A plan card needs the business requirement as its prompt.");
	}
	const decision = await resolvePlanAssignment(
		{
			workspaceId: input.workspaceId,
			agentId: input.agentId,
			agentSettings: input.agentSettings,
			startInPlanMode: input.startInPlanMode,
		},
		options,
	);
	if (!decision.ok) {
		throw new Error(decision.error);
	}
	const title = input.title?.trim() || `Plan: ${firstLine(input.requirement).slice(0, 80)}`;
	const requested = input.slug ?? slugifyPlanTitle(title.replace(/^Plan:\s*/iu, ""));
	const parsedSlug = planSlugSchema.safeParse(requested);
	if (!parsedSlug.success) {
		throw new Error(`Invalid plan slug "${requested}": ${parsedSlug.error.issues[0]?.message ?? "invalid"}.`);
	}
	const slug = chooseUniquePlanSlug(await options.index.read(input.workspaceId), parsedSlug.data);
	return {
		kitName: decision.kitName,
		outcome: decision.outcome,
		title,
		prompt: buildPlanPrompt({
			requirement: input.requirement,
			slug,
			rules: decision.rules,
			startInPlanMode: decision.startInPlanMode,
		}),
		slug,
		agentId: decision.agentId,
		agentSettings: decision.agentSettings,
		startInPlanMode: decision.startInPlanMode,
		issues: decision.issues,
	};
}

/** Writes the created plan card's index entry. */
export async function recordPlanCard(
	index: PlanIndexStore,
	workspaceId: string,
	prepared: PreparedPlanCard,
	task: { id: string; title: string },
	now: Date = new Date(),
): Promise<PlanRecord> {
	const record: PlanRecord = {
		taskId: task.id,
		slug: prepared.slug,
		title: task.title,
		createdAt: now.toISOString(),
		kit: prepared.kitName,
		agentId: prepared.agentId ?? null,
		providerId: prepared.agentSettings?.providerId ?? null,
		modelId: prepared.agentSettings?.modelId ?? null,
		startInPlanMode: prepared.startInPlanMode,
		approval: null,
		expansion: null,
		metrics: null,
	};
	await index.update(workspaceId, (current) => ({ ...current, plans: { ...current.plans, [task.id]: record } }));
	return record;
}
