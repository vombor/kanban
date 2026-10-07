// The routing-kit schema (plan §3.2). A kit is a declarative JSON document that answers the core's routing
// questions (src/kits/policy.ts) for one project: which agent and model a new dev card gets, whether a card gets
// QA and from whom, and what happens after a FAIL. It never holds mechanics (landing mode, limits, timings):
// those are core settings (src/config/pipeline-config.ts).
//
// The schema is versioned (`"kit": 1`) and strict: an unknown key is an error, not a silent no-op. A missing key
// means "no answer"; the resolver (resolve-kit.ts) then takes the `default` kit's value.
import { z } from "zod";

import { landingModeSchema } from "../config/pipeline-config";
import { runtimeAgentIdSchema, runtimeTaskRoleSchema } from "../core/api-contract";

export const KIT_SCHEMA_VERSION = 1;

/** Kit names are file names in `$KANBAN_HOME/kits/`. */
export const kitNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9_-]*$/u, "must be lowercase letters, digits, '-' or '_' (it is a file name)");

/** A card's role. `dev` cards are the work; QA, TRIAGE and calibration cards are never QA'd or reworked. */
export const cardRoleSchema = runtimeTaskRoleSchema;
export type CardRole = z.infer<typeof cardRoleSchema>;

/** The built-in features a kit can switch on (repo code in `src/kits/team/`, P4-T*). */
export const kitFeatureSchema = z.enum(["scoreboard", "bench", "runoffs", "calibration", "tiers"]);
export type KitFeature = z.infer<typeof kitFeatureSchema>;

const regexSourceSchema = z.string().superRefine((source, context) => {
	try {
		new RegExp(source);
	} catch (error) {
		context.addIssue({
			code: "custom",
			message: `not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
});

const providerSchema = z.string().min(1).nullable();

/** A concrete model. `provider: null` (or missing) = the agent's own default provider for that model. */
const explicitModelSchema = z.object({ provider: providerSchema.optional(), model: z.string().min(1) }).strict();
const tierRefSchema = z.object({ tier: z.string().min(1) }).strict();

export const kitModelRefSchema = z.union([tierRefSchema, explicitModelSchema]);
export type KitModelRef = z.infer<typeof kitModelRefSchema>;

export const kitTierEntrySchema = z
	.object({
		provider: providerSchema.optional(),
		model: z.string().min(1),
		default: z.boolean().optional(),
		note: z.string().optional(),
	})
	.strict();
export type KitTierEntry = z.infer<typeof kitTierEntrySchema>;

export const kitDroppedModelSchema = z
	.object({
		provider: providerSchema.optional(),
		model: z.string().min(1),
		at: z.string().optional(),
		why: z.string().optional(),
	})
	.strict();
export type KitDroppedModel = z.infer<typeof kitDroppedModelSchema>;

const qaAgentSchema = z
	.object({
		agent: runtimeAgentIdSchema,
		model: z.string().min(1).optional(),
		provider: providerSchema.optional(),
	})
	.strict();

export const kitQaRouteSchema = z
	.object({
		/** Matched against the dev card's effective model id; the first matching route wins. */
		devModel: regexSourceSchema,
		agent: runtimeAgentIdSchema,
		model: z.string().min(1).optional(),
		provider: providerSchema.optional(),
		/** Names of `qa.rules` texts added to the QA prompt. */
		rules: z.array(z.string().min(1)).optional(),
		why: z.string().optional(),
	})
	.strict();
export type KitQaRoute = z.infer<typeof kitQaRouteSchema>;

export const kitQaPromptNotesSchema = z
	.object({
		screenshotFallback: z.string().optional(),
		knownBaseIssues: z.string().optional(),
		dbSetup: z.string().optional(),
	})
	.strict();

const escalateTargetSchema = z.union([
	z.literal("orchestrator"),
	tierRefSchema,
	z.object({ agent: runtimeAgentIdSchema, model: z.string().min(1), provider: providerSchema.optional() }).strict(),
]);

const runoffModelSchema = z
	.object({ agent: runtimeAgentIdSchema, model: z.string().min(1), provider: providerSchema.optional() })
	.strict();

const postLandStepSchema = z
	.object({
		/** Run when a landed file path matches this regex. */
		paths: regexSourceSchema,
		run: z.string().min(1),
		stopUnder: z.array(z.string()).optional(),
	})
	.strict();

/** The kit document without the cross-key checks (used for single layers before they are merged). */
export const kitDocumentObjectSchema = z
	.object({
		kit: z.literal(KIT_SCHEMA_VERSION),
		name: kitNameSchema,
		description: z.string().optional(),
		dev: z
			.object({
				agent: runtimeAgentIdSchema.optional(),
				model: kitModelRefSchema.optional(),
			})
			.strict()
			.optional(),
		qa: z
			.object({
				enabled: z.boolean().optional(),
				requireDifferentVendor: z.boolean().optional(),
				skip: z
					.object({
						roles: z.array(cardRoleSchema).optional(),
						effectiveAgents: z.array(runtimeAgentIdSchema).optional(),
					})
					.strict()
					.optional(),
				default: qaAgentSchema.optional(),
				routes: z.array(kitQaRouteSchema).optional(),
				rules: z.record(z.string(), z.string()).optional(),
				blurb: z.string().optional(),
				promptNotes: kitQaPromptNotesSchema.optional(),
				serversScript: z.string().nullable().optional(),
				preview: z.string().nullable().optional(),
			})
			.strict()
			.optional(),
		onFail: z
			.object({
				rework: z.enum(["none", "same-model"]).optional(),
				reworkRounds: z.number().int().nonnegative().optional(),
				conflict: z.enum(["stop", "rework"]).optional(),
				// biome-ignore lint/suspicious/noThenProperty: the kit key from the plan (§3.2); kits are plain data, never awaited.
				then: z.enum(["escalate", "stop"]).optional(),
				runoff: z
					.object({ models: z.array(runoffModelSchema).min(1) })
					.strict()
					.nullable()
					.optional(),
			})
			.strict()
			.optional(),
		escalate: z
			.object({
				to: escalateTargetSchema.optional(),
				requireApproval: z.boolean().optional(),
			})
			.strict()
			.optional(),
		land: z
			.object({ postLand: z.array(postLandStepSchema).optional() })
			.strict()
			.optional(),
		features: z.array(kitFeatureSchema).optional(),
		tiers: z.record(z.string(), z.array(kitTierEntrySchema)).optional(),
		dropped: z.array(kitDroppedModelSchema).optional(),
		tierRules: z.record(z.string(), z.string()).optional(),
		tierNotes: z.record(z.string(), z.string()).optional(),
		prices: z.object({ region: z.string().optional(), autoSync: z.boolean().optional() }).strict().optional(),
		recommends: z.object({ landingMode: landingModeSchema.optional() }).strict().optional(),
	})
	.strict();

export type KitDocument = z.infer<typeof kitDocumentObjectSchema>;

export interface KitIssue {
	path: string;
	message: string;
}

// A dropped model is dropped on every provider: the provider is only the transport (the fork switch moved models
// from openai-native to bedrock under the same id). Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597
// ("same MODEL is the rule").
function isDroppedModel(kit: KitDocument, entry: { model: string }): boolean {
	return (kit.dropped ?? []).some((dropped) => dropped.model === entry.model);
}

/** The tier's usable entries: everything not in `dropped`. */
export function getUsableTierEntries(kit: KitDocument, tier: string): KitTierEntry[] {
	return (kit.tiers?.[tier] ?? []).filter((entry) => !isDroppedModel(kit, entry));
}

/**
 * Checks across keys that only make sense on a whole (resolved) kit: tier references point at a tier with a usable
 * model, at most one `default` per tier, route rules exist in `qa.rules`.
 */
export function findKitCrossKeyIssues(kit: KitDocument): KitIssue[] {
	const issues: KitIssue[] = [];
	const checkTierRef = (path: string, tier: string) => {
		if (!kit.tiers || !Object.hasOwn(kit.tiers, tier)) {
			issues.push({ path, message: `tier "${tier}" is not in tiers` });
		} else if (getUsableTierEntries(kit, tier).length === 0) {
			issues.push({ path, message: `tier "${tier}" has no model that isn't dropped` });
		}
	};
	if (kit.dev?.model && "tier" in kit.dev.model) {
		checkTierRef("dev.model.tier", kit.dev.model.tier);
	}
	if (kit.dev?.model && !kit.dev.agent) {
		issues.push({ path: "dev.model", message: "dev.model needs dev.agent" });
	}
	const escalateTo = kit.escalate?.to;
	if (escalateTo && typeof escalateTo === "object" && "tier" in escalateTo) {
		checkTierRef("escalate.to.tier", escalateTo.tier);
	}
	for (const [tier, entries] of Object.entries(kit.tiers ?? {})) {
		if (entries.filter((entry) => entry.default === true).length > 1) {
			issues.push({ path: `tiers.${tier}`, message: "more than one entry is marked default" });
		}
	}
	const ruleNames = new Set(Object.keys(kit.qa?.rules ?? {}));
	(kit.qa?.routes ?? []).forEach((route, index) => {
		for (const rule of route.rules ?? []) {
			if (!ruleNames.has(rule)) {
				issues.push({ path: `qa.routes.${index}.rules`, message: `rule "${rule}" is not in qa.rules` });
			}
		}
	});
	return issues;
}

/** The full kit schema: the document plus the cross-key checks. */
export const kitDocumentSchema = kitDocumentObjectSchema.superRefine((kit, context) => {
	for (const issue of findKitCrossKeyIssues(kit)) {
		context.addIssue({ code: "custom", path: issue.path.split("."), message: issue.message });
	}
});

export function formatKitIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
		.join("; ");
}
