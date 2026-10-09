// The registry of vetted agent CLI + provider + model combinations (`models/vetted.json`, bundled into dist/cli.js
// like the built-in kits; docs/team/MODELS.md). Projects route work only to combinations the registry has vetted for
// the role (src/kits/routing-vetting.ts), so a card never finds out the hard way that a model can't call tools, never
// ends its turn, rejects images or overflows its context.
//
// One entry per agent + provider + model. `provider: null` = the agent's own provider configuration (the agents
// Kanban can't hand a provider, and the Cline cards whose provider comes from `models.providers`); `model: null` =
// the agent's own default model. Each role (`dev`, `qa`, `plan`; the kit's fallback role builds, so it is `dev`) has
// its own vetting: status, when, on which CLI version, and the evidence. A combination can be fine for QA and not for
// dev. `rejected` refuses the whole combination; with `scope: "model"` it refuses the model on every agent and
// provider (the kits' old `dropped` list: the provider is only the transport, "same MODEL is the rule").
//
// Agent CLIs update themselves (user rule), so the CLI version is a record, not a gate: a newer CLI keeps the vetting.
// The registry changes only through the Kanban repo (a commit on fork/stack): `kanban models vet` writes a proposal,
// the Kanban orchestrator commits it. Never per project.
import { z } from "zod";

import vettedRegistryJson from "../../models/vetted.json" with { type: "json" };
import { type RuntimeAgentId, runtimeAgentIdEnumSchema } from "../core/api-contract";

export const VETTED_REGISTRY_VERSION = 1;

/** The roles a combination is vetted for. A kit's `fallback` role takes dev work over, so it is vetted as `dev`. */
export const VETTING_ROLES = ["dev", "qa", "plan"] as const;
export const vettingRoleSchema = z.enum(VETTING_ROLES);
export type VettingRole = z.infer<typeof vettingRoleSchema>;

export const vettingStatusSchema = z.enum(["vetted", "provisional", "rejected"]);
export type VettingStatus = z.infer<typeof vettingStatusSchema>;

/** A lookup's answer: a status, or `unknown` when the registry has no entry for the combination and role. */
export type RegistryStatus = VettingStatus | "unknown";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "a date (YYYY-MM-DD)");

export const vettingEvidenceSchema = z
	.object({
		/** The `kanban models vet` run id (`<home>/data/models/vetting/<run>`), a runoff or calibration name; null = none. */
		run: z.string().min(1).nullable(),
		summary: z.string().min(1),
	})
	.strict();

export const roleVettingSchema = z
	.object({
		status: vettingStatusSchema,
		at: isoDateSchema,
		/** The agent CLI's `--version` when it was vetted; null when it wasn't recorded. */
		cliVersion: z.string().min(1).nullable(),
		evidence: vettingEvidenceSchema,
		/** Why it is rejected for this role (required for `rejected`). */
		reason: z.string().min(1).optional(),
	})
	.strict()
	.superRefine((vetting, context) => {
		if (vetting.status === "rejected" && !vetting.reason) {
			context.addIssue({ code: "custom", path: ["reason"], message: "a rejected role needs a reason" });
		}
	});
export type RoleVetting = z.infer<typeof roleVettingSchema>;

export const combinationCapabilitiesSchema = z
	.object({
		/** Makes native tool calls (not tool calls written as text). null = not checked. */
		toolUse: z.boolean().nullable().optional(),
		/** Accepts images. */
		images: z.boolean().nullable().optional(),
		/** Context window in tokens, as the provider serves it. */
		contextWindow: z.number().int().positive().nullable().optional(),
		/** Ends its turns in a way Kanban sees without help (a hook or the agent's own session state). */
		turnEnd: z.boolean().nullable().optional(),
	})
	.strict();
export type CombinationCapabilities = z.infer<typeof combinationCapabilitiesSchema>;

export const combinationRejectionSchema = z
	.object({
		at: isoDateSchema,
		reason: z.string().min(1),
		/** `model`: the model is refused on every agent and provider; `combination` (default): only this one. */
		scope: z.enum(["combination", "model"]).optional(),
	})
	.strict();

export const vettedEntrySchema = z
	.object({
		agent: runtimeAgentIdEnumSchema,
		provider: z.string().min(1).nullable(),
		model: z.string().min(1).nullable(),
		roles: z
			.object({
				dev: roleVettingSchema.optional(),
				qa: roleVettingSchema.optional(),
				plan: roleVettingSchema.optional(),
			})
			.strict()
			.default({}),
		rejected: combinationRejectionSchema.optional(),
		capabilities: combinationCapabilitiesSchema.optional(),
		note: z.string().optional(),
	})
	.strict()
	.superRefine((entry, context) => {
		const roles = Object.entries(entry.roles);
		if (roles.length === 0 && !entry.rejected) {
			context.addIssue({ code: "custom", path: ["roles"], message: "an entry needs a role vetting or rejected" });
		}
		if (entry.rejected) {
			for (const [role, vetting] of roles) {
				if (vetting && vetting.status !== "rejected") {
					context.addIssue({
						code: "custom",
						path: ["roles", role, "status"],
						message: "the combination is rejected, so no role can be vetted or provisional",
					});
				}
			}
		}
		if (entry.rejected?.scope === "model" && entry.model === null) {
			context.addIssue({ code: "custom", path: ["rejected", "scope"], message: "scope model needs a model" });
		}
	});
export type VettedEntry = z.infer<typeof vettedEntrySchema>;

export const vettedRegistrySchema = z
	.object({
		$schema: z.string().optional(),
		registry: z.literal(VETTED_REGISTRY_VERSION),
		description: z.string().optional(),
		entries: z.array(vettedEntrySchema),
	})
	.strict()
	.superRefine((registry, context) => {
		const seen = new Map<string, number>();
		registry.entries.forEach((entry, index) => {
			const key = formatCombinationKey(entry);
			const first = seen.get(key);
			if (first !== undefined) {
				context.addIssue({
					code: "custom",
					path: ["entries", index],
					message: `${key} is already entries[${first}]; one entry per combination`,
				});
			} else {
				seen.set(key, index);
			}
		});
	});
export type VettedRegistry = z.infer<typeof vettedRegistrySchema>;

/** A combination as routing names it. */
export interface ModelCombination {
	agentId: RuntimeAgentId;
	/** null = none named (the agent's own provider config, or Kanban's `models.providers` for Cline). */
	provider: string | null;
	/** null = the agent's own default model. */
	model: string | null;
}

function formatCombinationKey(entry: { agent: string; provider: string | null; model: string | null }): string {
	return `${entry.agent}/${entry.provider ?? "(own provider)"}/${entry.model ?? "(own default model)"}`;
}

/** `cline + bedrock + us.anthropic.claude-haiku-5-5`, for messages. */
export function describeCombination(combination: ModelCombination): string {
	return [combination.agentId, combination.provider ?? null, combination.model ?? "its own default model"]
		.filter((part): part is string => part !== null)
		.join(" + ");
}

export function parseVettedRegistry(raw: unknown): VettedRegistry {
	const parsed = vettedRegistrySchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`The vetted model registry is invalid: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	return parsed.data;
}

let bundledRegistry: VettedRegistry | null = null;

/** The registry this Kanban build ships (`models/vetted.json`). */
export function getVettedRegistry(): VettedRegistry {
	bundledRegistry ??= parseVettedRegistry(vettedRegistryJson);
	return bundledRegistry;
}

const STATUS_RANK: Record<RegistryStatus, number> = { rejected: 0, unknown: 1, provisional: 2, vetted: 3 };

export interface RegistryVerdict {
	status: RegistryStatus;
	role: VettingRole;
	/** The entry the status came from; null for `unknown`. */
	entry: VettedEntry | null;
	/** The role's vetting record, when the entry has one. */
	vetting: RoleVetting | null;
	/** Why it is rejected, for `rejected`. */
	reason: string | null;
}

function sameModelId(left: string | null, right: string | null): boolean {
	return (left?.trim() ?? null) === (right?.trim() ?? null);
}

function judgeEntry(entry: VettedEntry, role: VettingRole): RegistryVerdict {
	if (entry.rejected) {
		return { status: "rejected", role, entry, vetting: entry.roles[role] ?? null, reason: entry.rejected.reason };
	}
	const vetting = entry.roles[role] ?? null;
	return {
		status: vetting?.status ?? "unknown",
		role,
		entry,
		vetting,
		reason: vetting?.status === "rejected" ? (vetting.reason ?? null) : null,
	};
}

/**
 * What the registry says about a combination for a role. A model rejected with `scope: "model"` is rejected on any
 * agent and provider. Otherwise the entry of the same agent and model counts; providers count only where both sides
 * name one, and when several entries fit (no provider named), the least permissive one answers.
 */
export function lookupVetting(
	registry: VettedRegistry,
	combination: ModelCombination,
	role: VettingRole,
): RegistryVerdict {
	if (combination.model !== null) {
		const modelWide = registry.entries.find(
			(entry) => entry.rejected?.scope === "model" && sameModelId(entry.model, combination.model),
		);
		if (modelWide) {
			return judgeEntry(modelWide, role);
		}
	}
	const candidates = registry.entries.filter(
		(entry) =>
			entry.agent === combination.agentId &&
			sameModelId(entry.model, combination.model) &&
			(entry.provider === null || combination.provider === null || entry.provider === combination.provider),
	);
	const exact = candidates.filter((entry) => entry.provider === combination.provider);
	const pool = exact.length > 0 ? exact : candidates;
	const verdicts = pool.map((entry) => judgeEntry(entry, role));
	if (verdicts.length === 0) {
		return { status: "unknown", role, entry: null, vetting: null, reason: null };
	}
	return verdicts.reduce((worst, verdict) =>
		STATUS_RANK[verdict.status] < STATUS_RANK[worst.status] ? verdict : worst,
	);
}

/** Models rejected on every agent and provider (`rejected.scope: "model"`): a tier lookup never picks them. */
export function listModelWideRejections(
	registry: VettedRegistry,
): Array<{ model: string; at: string; reason: string }> {
	return registry.entries.flatMap((entry) =>
		entry.rejected?.scope === "model" && entry.model !== null
			? [{ model: entry.model, at: entry.rejected.at, reason: entry.rejected.reason }]
			: [],
	);
}

/** The status shown for an entry and role in listings. */
export function getEntryRoleStatus(entry: VettedEntry, role: VettingRole): RegistryStatus {
	return judgeEntry(entry, role).status;
}

/** The JSON Schema of models/vetted.json (`npx tsx scripts/write-vetted-schema.ts` writes models/vetted.schema.json). */
export function buildVettedRegistryJsonSchema(): unknown {
	return z.toJSONSchema(vettedRegistrySchema, { io: "input", unrepresentable: "any" });
}
