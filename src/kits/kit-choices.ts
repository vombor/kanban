// The kits a new project can start on (user request 2026-10-12: "ask which routing kit it uses, defaulting to
// default"): every path that creates or first adds a project (the browser's add-project dialog, `kanban project
// create|add`) offers these, `default` first and preselected, each with its description and its four role models
// from the resolved kit, so user kits show the same way. The choice is applied through `kanban kit apply`'s code
// (apply-kit.ts, via src/projects/project-add.ts); this module only lists and checks names.
import type { RuntimeAgentId } from "../core/api-contract";
import { resolveKitRole } from "./kit-roles";
import { KIT_ROLE_NAMES, type KitRoleName } from "./kit-schema";
import { BUILT_IN_KIT_NAMES, DEFAULT_KIT_NAME, type KitCatalog, resolveKitByName } from "./resolve-kit";

export interface KitChoiceRole {
	role: KitRoleName;
	/** False: the kit has no such role (dev/plan run on the selected agent, no QA reviewer, no fallback). */
	defined: boolean;
	/** None: the agent selected in Kanban settings (the fallback: the dev role's agent). */
	agentId: RuntimeAgentId | null;
	provider: string | null;
	/** None: the agent's own default model. */
	model: string | null;
	tier: string | null;
}

export interface KitChoice {
	name: string;
	description: string | null;
	origin: "built-in" | "user";
	/** Always the four roles, in schema order. */
	roles: KitChoiceRole[];
}

export interface KitChoiceList {
	defaultKitName: string;
	kits: KitChoice[];
	/** User kits that can't be offered (refused files, or a kit that doesn't resolve). */
	errors: Array<{ name: string; error: string }>;
}

/** The kits a new project may pick: `default`, the other built-in kits in their order, then user kits by name. */
export function listKitChoices(catalog: KitCatalog): KitChoiceList {
	const kits: KitChoice[] = [];
	const errors: KitChoiceList["errors"] = catalog.errors.map((entry) => ({ name: entry.path, error: entry.error }));
	const names = [...catalog.kits.keys()].sort((left, right) => {
		const leftIndex = BUILT_IN_KIT_NAMES.indexOf(left);
		const rightIndex = BUILT_IN_KIT_NAMES.indexOf(right);
		if (leftIndex !== -1 || rightIndex !== -1) {
			return (
				(leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
				(rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
			);
		}
		return left.localeCompare(right);
	});
	for (const name of names) {
		const entry = catalog.kits.get(name);
		const resolved = resolveKitByName(catalog, name);
		if (!entry || !resolved.ok) {
			errors.push({ name, error: resolved.ok ? "missing" : resolved.error });
			continue;
		}
		kits.push({
			name,
			description: resolved.kit.description ?? null,
			origin: entry.origin.kind,
			roles: KIT_ROLE_NAMES.map((role) => {
				const assignment = resolveKitRole(resolved.kit, role);
				return {
					role,
					defined: assignment !== null,
					agentId: assignment?.agentId ?? null,
					provider: assignment?.model?.provider ?? null,
					model: assignment?.model?.model ?? null,
					tier: assignment?.tier ?? null,
				};
			}),
		});
	}
	return { defaultKitName: DEFAULT_KIT_NAME, kits, errors };
}

/**
 * The kit a new project starts on: `default` when none is named, else the named kit if it resolves. Throws with the
 * resolver's reason (unknown, renamed, invalid) so a caller can refuse before it creates or registers anything.
 */
export function resolveNewProjectKitName(catalog: KitCatalog, name: string | undefined): string {
	const kitName = name?.trim() || DEFAULT_KIT_NAME;
	const resolved = resolveKitByName(catalog, kitName);
	if (!resolved.ok) {
		throw new Error(`Kit ${kitName} can't be used: ${resolved.error}.`);
	}
	return kitName;
}
