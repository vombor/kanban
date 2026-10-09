// The team kit's `tiers` feature (plan §3.2): model tiers as data (`tiers`, `dropped`, `tierRules`, `tierNotes`).
// What uses them:
//   - `dev.model: { tier }` at card creation (the P3-1 evaluator, tier-lookup.ts);
//   - `escalate.to: { tier }`: the evaluator answers an escalation with that tier's model only while the kit lists
//     the `tiers` feature (src/kits/policy.ts); the rework loop then creates the sibling card on it;
//   - `kanban bench tiers`: this report.
// The feature has no runtime behaviour of its own: it is registered so a kit listing it isn't reported as naming a
// feature this build doesn't have.
//
// The data was the legacy kit's `benchmark.tiers`/`benchmark.dropped` (archive/devteam-kit:lib/config.cjs@6da71597),
// which only people read; the lookup rules are in tier-lookup.ts and kit-schema.ts (getUsableTierEntries).
import type { PipelineFeature } from "../../../pipeline/features";
import type { KitDocument } from "../../kit-schema";
import { lookupTierModel } from "../../tier-lookup";

export interface TierReportEntry {
	provider: string | null;
	model: string;
	default: boolean;
	/** Listed in `dropped` (never picked). */
	dropped: boolean;
	/** The model the tier lookup picks for this tier. */
	picked: boolean;
	note: string | null;
}

export interface TierReport {
	name: string;
	rule: string | null;
	note: string | null;
	entries: TierReportEntry[];
	/** The lookup's answer, or why there is none. */
	pick: { provider: string | null; model: string } | { error: string };
}

export interface TiersReport {
	kitName: string;
	/** Whether the kit lists the `tiers` feature (needed for `escalate.to: { tier }`). */
	featureOn: boolean;
	tiers: TierReport[];
	dropped: Array<{ provider: string | null; model: string; at: string | null; why: string | null }>;
	/** Which tier `roles.dev` and `roles.fallback` name, if any. */
	uses: { devTier: string | null; escalateTier: string | null };
}

export function buildTiersReport(kit: KitDocument): TiersReport {
	const droppedModels = new Set((kit.dropped ?? []).map((entry) => entry.model));
	const tiers = Object.entries(kit.tiers ?? {}).map(([name, entries]): TierReport => {
		const lookup = lookupTierModel(kit, name);
		const pick = lookup.ok ? lookup.choice : { error: lookup.error };
		return {
			name,
			rule: kit.tierRules?.[name] ?? null,
			note: kit.tierNotes?.[name] ?? null,
			entries: entries.map((entry) => ({
				provider: entry.provider ?? null,
				model: entry.model,
				default: entry.default === true,
				dropped: droppedModels.has(entry.model),
				picked:
					lookup.ok && lookup.choice.model === entry.model && lookup.choice.provider === (entry.provider ?? null),
				note: entry.note ?? null,
			})),
			pick,
		};
	});
	return {
		kitName: kit.name,
		featureOn: (kit.features ?? []).includes("tiers"),
		tiers,
		dropped: (kit.dropped ?? []).map((entry) => ({
			provider: entry.provider ?? null,
			model: entry.model,
			at: entry.at ?? null,
			why: entry.why ?? null,
		})),
		uses: {
			devTier: kit.roles?.dev?.tier ?? null,
			escalateTier: kit.roles?.fallback?.tier ?? null,
		},
	};
}

function formatModel(model: { provider: string | null; model: string }): string {
	return model.provider ? `${model.provider}/${model.model}` : model.model;
}

export function formatTiersReport(report: TiersReport): string[] {
	const lines = [`Kit ${report.kitName}: tiers feature ${report.featureOn ? "on" : "off"}`];
	if (report.tiers.length === 0) {
		lines.push("No tiers.");
	}
	for (const tier of report.tiers) {
		const pick = "error" in tier.pick ? `no pick (${tier.pick.error})` : `picks ${formatModel(tier.pick)}`;
		lines.push("", `${tier.name}: ${pick}`);
		if (tier.rule) {
			lines.push(`  rule: ${tier.rule}`);
		}
		if (tier.note) {
			lines.push(`  note: ${tier.note}`);
		}
		for (const entry of tier.entries) {
			const flags = [
				entry.picked ? "picked" : null,
				entry.default ? "default" : null,
				entry.dropped ? "DROPPED" : null,
			]
				.filter(Boolean)
				.join(", ");
			lines.push(`  - ${formatModel(entry)}${flags ? ` [${flags}]` : ""}${entry.note ? `: ${entry.note}` : ""}`);
		}
	}
	if (report.dropped.length > 0) {
		lines.push("", "Dropped (skipped on every provider):");
		for (const entry of report.dropped) {
			lines.push(`  - ${formatModel(entry)}${entry.at ? ` (${entry.at})` : ""}${entry.why ? `: ${entry.why}` : ""}`);
		}
	}
	lines.push(
		"",
		`roles.dev: ${report.uses.devTier ? `tier ${report.uses.devTier}` : "no tier"}; roles.fallback: ${report.uses.escalateTier ? `tier ${report.uses.escalateTier}${report.featureOn ? "" : " (ignored: the tiers feature is off, fallbacks go to the orchestrator)"}` : "no tier"}`,
	);
	return lines;
}

export function createTiersFeature(): PipelineFeature {
	return { name: "tiers", activate: () => undefined };
}
