// Legacy kit keys → the team definition's `roles` and `fallback` sections (kit-schema.ts). Kits and overrides written
// before the split named each role's model in its own section (`dev.agent`/`dev.model`, `qa.default`,
// `plan.agent`/`plan.model`) and the fallback as an escalation target (`escalate.to`, `escalate.requireApproval`,
// `onOutage.then`/`afterMin`). They keep working: the resolver translates every layer (a kit file, a workspace's
// overrides) with these functions before it merges, so a key keeps its layer's precedence and a resolved kit only
// has the new keys. Nothing else reads the legacy keys.
//
// What each legacy key meant, and is translated to:
//   dev.agent / dev.model ({tier} | {provider?, model})   → roles.dev.agent / roles.dev.tier | roles.dev.{provider, model}
//   qa.default.{agent, provider, model}                  → roles.qa.{agent, provider, model}
//   plan.agent / plan.model                              → roles.plan.agent / roles.plan.tier | roles.plan.{provider, model}
//   escalate.to: "orchestrator"                          → fallback.on: every trigger off (outages too)
//   escalate.to: {tier} | {agent, provider?, model}      → roles.fallback, and fallback.on.{qaFails, qaStalled,
//                                                          unchanged, conflict}: every onFail escalation took it
//   escalate.requireApproval                             → fallback.requireApproval
//   onOutage.then: "escalate" | "orchestrator"           → fallback.on.outage: true | false
//   onOutage.afterMin                                    → fallback.outageAfterMin

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The first segment(s) of a dotted key that are legacy. */
const LEGACY_KEY_PREFIXES = ["dev", "qa.default", "plan.agent", "plan.model", "escalate", "onOutage"] as const;

export function isLegacyKitKey(key: string): boolean {
	return LEGACY_KEY_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

/** A legacy model reference (`{ tier }` or `{ provider?, model }`) as role fields. */
function roleFieldsFromModelRef(ref: unknown): PlainObject {
	if (!isPlainObject(ref)) {
		return {};
	}
	if (typeof ref.tier === "string") {
		return { tier: ref.tier };
	}
	return {
		...(ref.model !== undefined ? { model: ref.model } : {}),
		...(ref.provider !== undefined ? { provider: ref.provider } : {}),
	};
}

function ensureObject(parent: PlainObject, key: string): PlainObject {
	const current = parent[key];
	if (isPlainObject(current)) {
		return current;
	}
	const created: PlainObject = {};
	parent[key] = created;
	return created;
}

/** Puts legacy role fields under `roles.<role>`; the layer's own `roles.<role>` keys win. */
function assignRole(layer: PlainObject, role: string, fields: PlainObject): void {
	if (Object.keys(fields).length === 0) {
		return;
	}
	const roles = ensureObject(layer, "roles");
	const own = isPlainObject(roles[role]) ? (roles[role] as PlainObject) : {};
	roles[role] = { ...fields, ...own };
}

/** Sets a fallback key unless the layer sets it with the new key itself. */
function assignFallback(layer: PlainObject, path: string[], value: unknown): void {
	let node = ensureObject(layer, "fallback");
	for (const segment of path.slice(0, -1)) {
		node = ensureObject(node, segment);
	}
	const leaf = path[path.length - 1] as string;
	if (!Object.hasOwn(node, leaf)) {
		node[leaf] = value;
	}
}

const ONFAIL_TRIGGERS = ["qaFails", "qaStalled", "unchanged", "conflict"] as const;

/**
 * One layer (a kit document or a sparse object built from overrides) with its legacy keys translated. Returns a new
 * object and the legacy keys it found (dotted, as written).
 */
export function translateLegacyKitLayer(layer: PlainObject): { layer: PlainObject; legacyKeys: string[] } {
	const out = structuredClone(layer);
	const legacyKeys: string[] = [];
	if (isPlainObject(out.dev)) {
		legacyKeys.push("dev");
		assignRole(out, "dev", {
			...(out.dev.agent !== undefined ? { agent: out.dev.agent } : {}),
			...roleFieldsFromModelRef(out.dev.model),
		});
		delete out.dev;
	}
	if (isPlainObject(out.qa) && isPlainObject(out.qa.default)) {
		legacyKeys.push("qa.default");
		const qaDefault = out.qa.default;
		assignRole(out, "qa", {
			...(qaDefault.agent !== undefined ? { agent: qaDefault.agent } : {}),
			...(qaDefault.model !== undefined ? { model: qaDefault.model } : {}),
			...(qaDefault.provider !== undefined ? { provider: qaDefault.provider } : {}),
		});
		delete out.qa.default;
	}
	if (isPlainObject(out.plan) && (out.plan.agent !== undefined || out.plan.model !== undefined)) {
		const plan = out.plan;
		legacyKeys.push(...["plan.agent", "plan.model"].filter((key) => plan[key.slice(5)] !== undefined));
		assignRole(out, "plan", {
			...(plan.agent !== undefined ? { agent: plan.agent } : {}),
			...roleFieldsFromModelRef(plan.model),
		});
		delete plan.agent;
		delete plan.model;
	}
	let toOrchestrator = false;
	if (isPlainObject(out.escalate)) {
		legacyKeys.push("escalate");
		const { to, requireApproval } = out.escalate;
		if (to === "orchestrator") {
			toOrchestrator = true;
			for (const trigger of [...ONFAIL_TRIGGERS, "outage"]) {
				assignFallback(out, ["on", trigger], false);
			}
		} else if (isPlainObject(to)) {
			assignRole(out, "fallback", {
				...(to.agent !== undefined ? { agent: to.agent } : {}),
				// `{agent, model}` without a provider meant the agent's default provider, whatever a lower layer says.
				...(typeof to.tier === "string" ? { tier: to.tier } : { model: to.model, provider: to.provider ?? null }),
			});
			for (const trigger of ONFAIL_TRIGGERS) {
				assignFallback(out, ["on", trigger], true);
			}
		}
		if (requireApproval !== undefined) {
			assignFallback(out, ["requireApproval"], requireApproval);
		}
		delete out.escalate;
	}
	if (isPlainObject(out.onOutage)) {
		legacyKeys.push("onOutage");
		const { afterMin } = out.onOutage;
		const then = out.onOutage.then;
		// An outage takeover needed a model to escalate to: with escalate.to orchestrator it held instead.
		if (then !== undefined) {
			assignFallback(out, ["on", "outage"], then === "escalate" && !toOrchestrator);
		}
		if (afterMin !== undefined) {
			assignFallback(out, ["outageAfterMin"], afterMin);
		}
		delete out.onOutage;
	}
	return { layer: out, legacyKeys };
}

function setPath(target: PlainObject, segments: string[], value: unknown): void {
	let node = target;
	for (const segment of segments.slice(0, -1)) {
		node = ensureObject(node, segment);
	}
	node[segments[segments.length - 1] as string] = structuredClone(value);
}

/** Leaf keys of a translated sparse layer (arrays and non-empty values are leaves; empty objects are dropped). */
function flattenLeaves(value: unknown, prefix: string[], into: Record<string, unknown>): void {
	if (!isPlainObject(value)) {
		into[prefix.join(".")] = value;
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		flattenLeaves(child, [...prefix, key], into);
	}
}

export interface TranslatedOverrides {
	/** The overrides with every legacy key replaced by the new keys it means; a new key set alongside wins. */
	overrides: Record<string, unknown>;
	/** Legacy key → the new keys it became. */
	renamed: Array<{ from: string; to: string[] }>;
}

/** A workspace's overrides (dotted kit keys) with their legacy keys translated. */
export function translateLegacyOverrides(overrides: Record<string, unknown>): TranslatedOverrides {
	const legacyEntries = Object.entries(overrides).filter(([key]) => isLegacyKitKey(key));
	if (legacyEntries.length === 0) {
		return { overrides: { ...overrides }, renamed: [] };
	}
	// Translated together: `escalate.to: "orchestrator"` changes what `onOutage.then` means.
	const sparse: PlainObject = {};
	for (const [key, value] of legacyEntries) {
		setPath(sparse, key.split("."), value);
	}
	const translated: Record<string, unknown> = {};
	flattenLeaves(translateLegacyKitLayer(sparse).layer, [], translated);
	const renamed = legacyEntries.map(([key, value]) => {
		const own: PlainObject = {};
		setPath(own, key.split("."), value);
		const leaves: Record<string, unknown> = {};
		flattenLeaves(translateLegacyKitLayer(own).layer, [], leaves);
		return { from: key, to: Object.keys(leaves) };
	});
	for (const [key, value] of Object.entries(overrides)) {
		if (!isLegacyKitKey(key)) {
			translated[key] = value;
		}
	}
	return { overrides: translated, renamed };
}
