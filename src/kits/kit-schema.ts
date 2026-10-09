// The routing-kit schema (plan §3.2). A kit is a declarative JSON document that answers the core's routing
// questions (src/kits/policy.ts) for one project: which agent and model a new dev card gets, whether a card gets
// QA and from whom, and what happens after a FAIL. It never holds mechanics (landing mode, limits, timings):
// those are core settings (src/config/pipeline-config.ts). The `plan` section answers the same kind of question for
// plan cards (`planAssignment`): which agent and model a planner runs on, and whether it starts in plan mode.
//
// The schema is versioned (`"kit": 1`) and strict: an unknown key is an error, not a silent no-op. A missing key
// means "no answer"; the resolver (resolve-kit.ts) then takes the `default` kit's value.
//
// A kit is the TEAM DEFINITION: its roles with a default model each (`roles.<role>`), and the flow (QA on/off and
// routes, rework rounds, which triggers hand a card to the fallback role and whether that needs approval, features,
// the landing recommendation). A project changes only its PROJECT SETTINGS on top (`workspaces.<id>.kit.overrides`,
// src/kits/project-settings.ts): any role's model, and project facts (QA blurb and prompt notes, post-land commands,
// ...). Everything else is the team: a project gets another team by using another kit (`kanban kit apply`).
//
// Legacy keys (`dev.agent`/`dev.model`, `qa.default`, `plan.agent`/`plan.model`, `escalate.*`, `onOutage.*`) still
// parse in kit files and overrides; the resolver translates each layer into `roles`/`fallback` before merging
// (src/kits/kit-legacy-keys.ts), so a resolved kit never has them and no reader looks at them.
import { z } from "zod";

import { landingModeSchema } from "../config/pipeline-config";
import { runtimeAgentIdSchema, runtimeTaskRoleSchema } from "../core/api-contract";
import { getVettedRegistry, listModelWideRejections } from "../models/vetted-registry";

export const KIT_SCHEMA_VERSION = 1;

/** Kit names are file names in `$KANBAN_HOME/kits/`. */
export const kitNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9_-]*$/u, "must be lowercase letters, digits, '-' or '_' (it is a file name)");

/** A card's role. `dev` cards are the work; QA, TRIAGE, calibration and plan cards are never QA'd or reworked. */
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

/**
 * The project preview QA screenshots go through (the legacy `qaPreview`): `start` and `stop` run with `sh -c` in the
 * project, and `start` writes the preview's pid to `pidFile` (relative to the project). The QA gate starts it before
 * a QA card when it is down and stops it once QA is idle, only if the pid is still the one it started.
 */
export const kitQaPreviewSchema = z
	.object({ pidFile: z.string().min(1), start: z.string().min(1), stop: z.string().min(1) })
	.strict();
export type KitQaPreview = z.infer<typeof kitQaPreviewSchema>;

/** A path relative to the project, inside it (no absolute path, no `..` segment). */
const projectRelativePathSchema = z
	.string()
	.min(1)
	.refine(
		(path) => !path.startsWith("/") && !path.split(/[\\/]/u).includes(".."),
		"a path relative to the project, without ..",
	);

/**
 * The project's environment for the scripted checks (src/pipeline/checks-project-env.ts, docs/team/WORKFLOW.md
 * "Scripted checks"): the card worktree's `envFile` is copied into the checks export and loaded into every step;
 * `databaseUrlVar` gives the run its own database (the URL in that variable with its database name replaced by the
 * run's `CHECKS_DB`); `setup` runs (`sh -c`, in the export) after the install and before the scripts, `teardown`
 * after them, whatever happened. All of it is a project fact.
 */
export const kitChecksSchema = z
	.object({
		envFile: projectRelativePathSchema.optional(),
		databaseUrlVar: z
			.string()
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "an environment variable name")
			.optional(),
		setup: z.string().min(1).nullable().optional(),
		teardown: z.string().min(1).nullable().optional(),
	})
	.strict();
export type KitChecks = z.infer<typeof kitChecksSchema>;

/**
 * Which git-ignored paths of the main checkout a task worktree gets as symlinks (src/workspace/worktree-link-rule.ts,
 * docs/team/KITS.md "Task worktrees' ignored paths"): every ignored path is linked unless it matches the default
 * exclude list (databases, build and cache outputs, logs) or `exclude`; `include` links a default-excluded path
 * again, and `exclude` wins over `include`. Globs: `*`, `?`, `**`; a glob without `/` matches any path segment. A
 * project fact.
 */
export const kitWorktreeSymlinkIgnoredSchema = z
	.object({
		include: z.array(z.string().min(1)).optional(),
		exclude: z.array(z.string().min(1)).optional(),
	})
	.strict();
export type KitWorktreeSymlinkIgnored = z.infer<typeof kitWorktreeSymlinkIgnoredSchema>;

/**
 * An agent and model a plan card could run on. `plan.agent`/`plan.model` are the one in use; `plan.candidates` lists
 * the others a later runoff or calibration compares (Claude, Codex, Copilot), so that needs no schema change.
 */
export const kitPlanCandidateSchema = z
	.object({
		agent: runtimeAgentIdSchema,
		model: kitModelRefSchema.optional(),
		note: z.string().optional(),
	})
	.strict();
export type KitPlanCandidate = z.infer<typeof kitPlanCandidateSchema>;

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

/**
 * A core setting the kit's routing needs (`recommends.settings`): a dotted key of config.json, where `workspace.`
 * means the project's own `workspaces.<id>` entry. Like `recommends.landingMode` it is shown (`kanban kit show`)
 * and checked (`kanban doctor`), never applied: the kit holds no mechanics.
 */
export const kitRecommendedSettingSchema = z
	.object({
		key: z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/u, "a dotted config.json key"),
		/** `equals` (default), or a number bound: `atMost`, `atLeast`. */
		op: z.enum(["equals", "atMost", "atLeast"]).optional(),
		value: z.union([z.string(), z.number(), z.boolean()]),
		why: z.string().min(1),
	})
	.strict()
	.superRefine((setting, context) => {
		if (setting.op && setting.op !== "equals" && typeof setting.value !== "number") {
			context.addIssue({ code: "custom", path: ["value"], message: `${setting.op} needs a number` });
		}
	});
export type KitRecommendedSetting = z.infer<typeof kitRecommendedSettingSchema>;

/**
 * The kit's roles: who works on a card, each with the kit's default model. `dev` builds (new dev cards), `qa` reviews
 * (the QA reviewer when no `qa.routes` entry matches the dev card's model), `plan` plans (plan cards), `fallback`
 * takes a dev card's task over on a sibling card when a `fallback.on` trigger fires.
 */
export const KIT_ROLE_NAMES = ["dev", "qa", "plan", "fallback"] as const;
export const kitRoleNameSchema = z.enum(KIT_ROLE_NAMES);
export type KitRoleName = z.infer<typeof kitRoleNameSchema>;

/**
 * One role's agent and model. `model` (with an optional `provider`; none = the agent's own default provider) or
 * `tier` (the tier's pick, its provider included), never both; neither = the agent's own default model. No `agent`
 * = the agent selected in Kanban settings (dev, plan), the dev role's agent, else the card's (fallback).
 */
export const kitRoleModelSchema = z
	.object({
		agent: runtimeAgentIdSchema.optional(),
		provider: providerSchema.optional(),
		model: z.string().min(1).optional(),
		tier: z.string().min(1).optional(),
		note: z.string().optional(),
	})
	.strict();
export type KitRoleModel = z.infer<typeof kitRoleModelSchema>;

/** The leaf keys of a role a project can set (`roles.<role>.<field>`). */
export const KIT_ROLE_MODEL_FIELDS = ["agent", "provider", "model", "tier"] as const;

/**
 * What hands a dev card's task to the `fallback` role (a sibling card on its model; the card goes to Backlog as
 * BLOCKED). A trigger that is off goes to the orchestrator, as does a fallback the core refuses: onto the model the
 * card already runs on, by a card that is itself a fallback sibling, or by a card racing in a runoff (#8).
 */
export const kitFallbackTriggersSchema = z
	.object({
		/** After `onFail.reworkRounds` failed QA rounds (needs `onFail.then: escalate`). */
		qaFails: z.boolean().optional(),
		/** QA STALLED/DNF (needs `onFail.then: escalate`). */
		qaStalled: z.boolean().optional(),
		/** A rework came back unchanged (needs `onFail.then: escalate`). */
		unchanged: z.boolean().optional(),
		/** A merge conflict at land after its rework rounds (`onFail.conflict: rework`, `onFail.then: escalate`). */
		conflict: z.boolean().optional(),
		/** A provider outage hold that lasted `fallback.outageAfterMin`. */
		outage: z.boolean().optional(),
	})
	.strict();
export type KitFallbackTriggers = z.infer<typeof kitFallbackTriggersSchema>;
export type KitFallbackTrigger = keyof KitFallbackTriggers;

/** The legacy keys a kit or an override may still use; translated away before a kit is merged. */
const legacyDevSchema = z
	.object({ agent: runtimeAgentIdSchema.optional(), model: kitModelRefSchema.optional() })
	.strict();
const legacyOnOutageSchema = z
	.object({
		// biome-ignore lint/suspicious/noThenProperty: named like onFail.then; kits are plain data, never awaited.
		then: z.enum(["escalate", "orchestrator"]).optional(),
		afterMin: z.number().positive().optional(),
	})
	.strict();
const legacyEscalateSchema = z
	.object({ to: escalateTargetSchema.optional(), requireApproval: z.boolean().optional() })
	.strict();

/** The kit document without the cross-key checks (used for single layers before they are merged). */
export const kitDocumentObjectSchema = z
	.object({
		kit: z.literal(KIT_SCHEMA_VERSION),
		name: kitNameSchema,
		description: z.string().optional(),
		roles: z
			.object({
				dev: kitRoleModelSchema.optional(),
				qa: kitRoleModelSchema.optional(),
				plan: kitRoleModelSchema.optional(),
				fallback: kitRoleModelSchema.optional(),
			})
			.strict()
			.optional(),
		/** Legacy: `roles.dev`. */
		dev: legacyDevSchema.optional(),
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
				/** Legacy: `roles.qa`. */
				default: qaAgentSchema.optional(),
				routes: z.array(kitQaRouteSchema).optional(),
				rules: z.record(z.string(), z.string()).optional(),
				blurb: z.string().optional(),
				promptNotes: kitQaPromptNotesSchema.optional(),
				serversScript: z.string().nullable().optional(),
				preview: kitQaPreviewSchema.nullable().optional(),
			})
			.strict()
			.optional(),
		plan: z
			.object({
				/** Whether `kanban task create --role plan` makes plan cards on this project. */
				enabled: z.boolean().optional(),
				/** Legacy: `roles.plan.agent`. */
				agent: runtimeAgentIdSchema.optional(),
				/** Legacy: `roles.plan.model`/`tier`. */
				model: kitModelRefSchema.optional(),
				startInPlanMode: z.boolean().optional(),
				/** Project rules added to the plan prompt, in key order. */
				rules: z.record(z.string(), z.string()).optional(),
				/** Agents and models a later runoff or calibration compares; never read for routing. */
				candidates: z.array(kitPlanCandidateSchema).optional(),
				note: z.string().optional(),
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
		fallback: z
			.object({
				on: kitFallbackTriggersSchema.optional(),
				/** Minutes of outage hold before the outage trigger fires; none = `pipeline.recovery.outage.maxMin`. */
				outageAfterMin: z.number().positive().optional(),
				/** The fallback sibling waits in Backlog until the orchestrator or the user starts it. */
				requireApproval: z.boolean().optional(),
				note: z.string().optional(),
			})
			.strict()
			.optional(),
		/** Legacy: `fallback.on.outage` / `fallback.outageAfterMin`. */
		onOutage: legacyOnOutageSchema.optional(),
		/** Legacy: `roles.fallback` + `fallback.on` / `fallback.requireApproval`. */
		escalate: legacyEscalateSchema.optional(),
		land: z
			.object({ postLand: z.array(postLandStepSchema).optional() })
			.strict()
			.optional(),
		checks: kitChecksSchema.optional(),
		worktrees: z.object({ symlinkIgnored: kitWorktreeSymlinkIgnoredSchema.optional() }).strict().optional(),
		features: z.array(kitFeatureSchema).optional(),
		tiers: z.record(z.string(), z.array(kitTierEntrySchema)).optional(),
		/** A user kit's own dropped models; the built-in kits' are in the vetted model registry (rejected, scope model). */
		dropped: z.array(kitDroppedModelSchema).optional(),
		tierRules: z.record(z.string(), z.string()).optional(),
		tierNotes: z.record(z.string(), z.string()).optional(),
		prices: z.object({ region: z.string().optional(), autoSync: z.boolean().optional() }).strict().optional(),
		recommends: z
			.object({
				landingMode: landingModeSchema.optional(),
				settings: z.array(kitRecommendedSettingSchema).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type KitDocument = z.infer<typeof kitDocumentObjectSchema>;

export interface KitIssue {
	path: string;
	message: string;
}

// A dropped model is dropped on every provider: the provider is only the transport (the fork switch moved models
// from openai-native to bedrock under the same id). Ported from archive/devteam-kit:services/kanban-autoland.mjs@6da71597
// ("same MODEL is the rule"). The rejected models live in the vetted model registry (models/vetted.json, `rejected`
// with `scope: "model"`); a kit's own `dropped` list (user kits) still counts on top.
function isDroppedModel(kit: KitDocument, entry: { model: string }): boolean {
	return (
		(kit.dropped ?? []).some((dropped) => dropped.model === entry.model) ||
		listModelWideRejections(getVettedRegistry()).some((rejected) => rejected.model === entry.model)
	);
}

/** The tier's usable entries: everything not in `dropped` or rejected model-wide in the vetted model registry. */
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
	for (const role of KIT_ROLE_NAMES) {
		const entry = kit.roles?.[role];
		if (!entry) {
			continue;
		}
		const path = `roles.${role}`;
		if (entry.tier !== undefined) {
			checkTierRef(`${path}.tier`, entry.tier);
		}
		if (entry.tier !== undefined && entry.model !== undefined) {
			issues.push({ path: `${path}.model`, message: `${path} names both a model and a tier; set one` });
		}
		if (entry.provider !== undefined && entry.provider !== null && entry.model === undefined) {
			issues.push({ path: `${path}.provider`, message: `${path}.provider needs ${path}.model` });
		}
		// A fallback without an agent runs on the dev role's agent (else the card's); the others need their own.
		if (role !== "fallback" && (entry.model !== undefined || entry.tier !== undefined) && !entry.agent) {
			issues.push({ path: `${path}.agent`, message: `${path}.model/tier needs ${path}.agent` });
		}
	}
	const triggers = kit.fallback?.on ?? {};
	const firing = Object.entries(triggers).filter(([, on]) => on === true);
	if (firing.length > 0 && !kit.roles?.fallback) {
		issues.push({
			path: "fallback.on",
			message: `fallback.on.${firing[0]?.[0]} hands cards to the fallback role, but the kit has no roles.fallback`,
		});
	}
	(kit.plan?.candidates ?? []).forEach((candidate, index) => {
		if (candidate.model && "tier" in candidate.model) {
			checkTierRef(`plan.candidates.${index}.model.tier`, candidate.model.tier);
		}
	});
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

/** Legacy keys in a document, as dotted keys; a resolved kit has none (src/kits/kit-legacy-keys.ts). */
export function listLegacyKitKeys(kit: KitDocument): string[] {
	return [
		kit.dev ? "dev" : null,
		kit.qa?.default ? "qa.default" : null,
		kit.plan?.agent !== undefined ? "plan.agent" : null,
		kit.plan?.model !== undefined ? "plan.model" : null,
		kit.escalate ? "escalate" : null,
		kit.onOutage ? "onOutage" : null,
	].filter((key): key is string => key !== null);
}

/**
 * The full kit schema: the document plus the cross-key checks. Used on merged (resolved) kits and the built-in ones,
 * which never carry legacy keys.
 */
export const kitDocumentSchema = kitDocumentObjectSchema.superRefine((kit, context) => {
	for (const key of listLegacyKitKeys(kit)) {
		context.addIssue({
			code: "custom",
			path: key.split("."),
			message: "a legacy key; translate it (kit-legacy-keys.ts)",
		});
	}
	for (const issue of findKitCrossKeyIssues(kit)) {
		context.addIssue({ code: "custom", path: issue.path.split("."), message: issue.message });
	}
});

export function formatKitIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
		.join("; ");
}
