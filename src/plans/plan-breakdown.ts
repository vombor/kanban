// A plan card's card breakdown: `docs/specs/<slug>.cards.json` in the plan card's worktree, next to the spec
// `docs/specs/<slug>.md`. The planner writes it (src/kits/plan-prompt.ts tells it this shape), `kanban plan check`
// lets it validate the file itself, and `kanban plan expand` refuses one that doesn't validate here.
//
// Beyond the zod shape, a breakdown must be a plan the board can run: unique local ids, dependencies that name
// another card of the breakdown, no cycles (a cycle would leave every card in it waiting forever), and no card
// depending (even transitively) on a card of its own parallel group, since a group is "these can run at once".
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const PLAN_BREAKDOWN_VERSION = 1;
/** Where specs go, relative to the repo root. */
export const PLAN_SPECS_DIR = "docs/specs";
/** More cards than this is not one plan: split the requirement into several plan cards. */
export const PLAN_MAX_CARDS = 30;

export const planSlugSchema = z
	.string()
	.regex(
		/^[a-z0-9][a-z0-9-]{0,63}$/u,
		"must be 1-64 lowercase letters, digits or '-', starting with a letter or digit",
	);

const localIdSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,39}$/u, "must be 1-40 lowercase letters, digits or '-' (a local id, not a task id)");

export const planBreakdownCardSchema = z
	.object({
		/** Local id other cards name in `dependsOn`. */
		id: localIdSchema,
		title: z.string().trim().min(1).max(120),
		/** The whole task for one agent session: what to change, where, and how to check it. */
		prompt: z.string().trim().min(20, "is too short to be a card prompt"),
		/** Plans produce dev cards only (QA cards come from the pipeline). */
		role: z.literal("dev").default("dev"),
		/** Local ids of cards that must be done (landed) before this one starts. */
		dependsOn: z.array(localIdSchema).default([]),
		/** Cards of one group can run at the same time. */
		parallelGroup: z.string().trim().min(1).optional(),
		acceptanceCriteria: z.array(z.string().trim().min(1)).min(1, "needs at least one acceptance criterion"),
	})
	.strict();
export type PlanBreakdownCard = z.infer<typeof planBreakdownCardSchema>;

export const planBreakdownSchema = z
	.object({
		version: z.literal(PLAN_BREAKDOWN_VERSION),
		/** The spec's slug: `docs/specs/<slug>.md`. */
		slug: planSlugSchema,
		/** One-paragraph summary of the plan. */
		summary: z.string().trim().min(1).optional(),
		cards: z.array(planBreakdownCardSchema).min(1, "has no cards").max(PLAN_MAX_CARDS),
	})
	.strict()
	.superRefine((breakdown, context) => {
		for (const issue of findPlanBreakdownGraphIssues(breakdown.cards)) {
			context.addIssue({ code: "custom", path: issue.path, message: issue.message });
		}
	});
export type PlanBreakdown = z.infer<typeof planBreakdownSchema>;

export interface PlanBreakdownIssue {
	path: Array<string | number>;
	message: string;
}

type GraphCard = Pick<PlanBreakdownCard, "id" | "dependsOn" | "parallelGroup">;

/** Ids, dependencies, cycles and parallel groups. */
export function findPlanBreakdownGraphIssues(cards: readonly GraphCard[]): PlanBreakdownIssue[] {
	const issues: PlanBreakdownIssue[] = [];
	const indexById = new Map<string, number>();
	cards.forEach((card, index) => {
		if (indexById.has(card.id)) {
			issues.push({ path: ["cards", index, "id"], message: `"${card.id}" is used by more than one card` });
		} else {
			indexById.set(card.id, index);
		}
	});
	cards.forEach((card, index) => {
		card.dependsOn.forEach((dependency, dependencyIndex) => {
			const path = ["cards", index, "dependsOn", dependencyIndex];
			if (dependency === card.id) {
				issues.push({ path, message: "a card can't depend on itself" });
			} else if (!indexById.has(dependency)) {
				issues.push({ path, message: `"${dependency}" is not a card of this breakdown` });
			}
		});
	});
	if (issues.length > 0) {
		return issues;
	}
	const byId = new Map(cards.map((card) => [card.id, card]));
	const cycle = findDependencyCycle(cards, byId);
	if (cycle) {
		return [{ path: ["cards"], message: `dependency cycle: ${cycle.join(" -> ")}` }];
	}
	const ancestors = new Map<string, Set<string>>();
	const ancestorsOf = (id: string): Set<string> => {
		const known = ancestors.get(id);
		if (known) {
			return known;
		}
		const found = new Set<string>();
		for (const dependency of byId.get(id)?.dependsOn ?? []) {
			found.add(dependency);
			for (const ancestor of ancestorsOf(dependency)) {
				found.add(ancestor);
			}
		}
		ancestors.set(id, found);
		return found;
	};
	cards.forEach((card, index) => {
		if (!card.parallelGroup) {
			return;
		}
		const sameGroup = [...ancestorsOf(card.id)].filter(
			(ancestor) => byId.get(ancestor)?.parallelGroup === card.parallelGroup,
		);
		if (sameGroup.length > 0) {
			issues.push({
				path: ["cards", index, "parallelGroup"],
				message: `"${card.id}" depends on ${sameGroup.map((id) => `"${id}"`).join(", ")} of its own parallel group "${card.parallelGroup}"`,
			});
		}
	});
	return issues;
}

function findDependencyCycle(cards: readonly GraphCard[], byId: Map<string, GraphCard>): string[] | null {
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	const visit = (id: string): string[] | null => {
		const current = state.get(id);
		if (current === "done") {
			return null;
		}
		if (current === "visiting") {
			return [...stack.slice(stack.indexOf(id)), id];
		}
		state.set(id, "visiting");
		stack.push(id);
		for (const dependency of byId.get(id)?.dependsOn ?? []) {
			const cycle = visit(dependency);
			if (cycle) {
				return cycle;
			}
		}
		stack.pop();
		state.set(id, "done");
		return null;
	};
	for (const card of cards) {
		const cycle = visit(card.id);
		if (cycle) {
			return cycle;
		}
	}
	return null;
}

export function formatPlanBreakdownIssues(error: z.ZodError): string[] {
	return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`);
}

export type PlanBreakdownParse = { ok: true; breakdown: PlanBreakdown } | { ok: false; issues: string[] };

/** Parses and validates a breakdown file's text. `expectedSlug`: the slug the plan card was made for. */
export function parsePlanBreakdown(text: string, expectedSlug?: string): PlanBreakdownParse {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { ok: false, issues: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
	}
	const parsed = planBreakdownSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, issues: formatPlanBreakdownIssues(parsed.error) };
	}
	if (expectedSlug && parsed.data.slug !== expectedSlug) {
		return {
			ok: false,
			issues: [`slug: "${parsed.data.slug}" is not the plan card's slug "${expectedSlug}"`],
		};
	}
	return { ok: true, breakdown: parsed.data };
}

export interface PlanSpecPaths {
	/** Relative to the repo root (as the spec and the prompts cite them). */
	specPath: string;
	breakdownPath: string;
}

export function getPlanSpecPaths(slug: string): PlanSpecPaths {
	return {
		specPath: `${PLAN_SPECS_DIR}/${slug}.md`,
		breakdownPath: `${PLAN_SPECS_DIR}/${slug}.cards.json`,
	};
}

/** A slug from a requirement's title: lowercase words joined by '-', at most 48 characters. */
export function slugifyPlanTitle(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 48)
		.replace(/-+$/u, "");
	return slug || "plan";
}

export interface PlanFiles {
	spec: string | null;
	breakdownText: string | null;
	paths: PlanSpecPaths & { worktreePath: string };
}

async function readTextIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

/** The spec and the breakdown text in a plan card's worktree (null when a file is missing). */
export async function readPlanFiles(worktreePath: string, slug: string): Promise<PlanFiles> {
	const paths = getPlanSpecPaths(slug);
	const [spec, breakdownText] = await Promise.all([
		readTextIfExists(join(worktreePath, paths.specPath)),
		readTextIfExists(join(worktreePath, paths.breakdownPath)),
	]);
	return { spec, breakdownText, paths: { ...paths, worktreePath } };
}
