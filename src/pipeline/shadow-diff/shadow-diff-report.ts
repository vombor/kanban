// Text form of a shadow diff report (shadow-diff.ts), as `scripts/pipeline-shadow-diff.ts` prints it.
import type { ShadowDiffCategory, ShadowDiffItem, ShadowDiffReport, ShadowDiffStatus } from "./shadow-diff";

const CATEGORY_TITLES: Record<ShadowDiffCategory, string> = {
	qa_routing: "QA routing",
	on_fail: "After a FAIL",
	recovery: "Recovery",
	restart: "Restart recovery",
	dev_assignment: "Dev assignment",
};

const STATUS_ORDER: readonly ShadowDiffStatus[] = [
	"same",
	"known",
	"unverified",
	"different",
	"legacy_only",
	"pipeline_only",
];

const STATUS_LABELS: Record<ShadowDiffStatus, string> = {
	same: "SAME",
	known: "KNOWN",
	unverified: "UNVERIFIED",
	different: "DIFF",
	legacy_only: "LEGACY ONLY",
	pipeline_only: "PIPELINE ONLY",
};

function formatItem(item: ShadowDiffItem): string[] {
	const lines = [
		`  ${STATUS_LABELS[item.status]} ${item.taskId ?? "-"} ${item.at}`,
		`      legacy:   ${item.legacy}`,
		`      pipeline: ${item.pipeline}`,
	];
	if (item.note) {
		lines.push(`      note:     ${item.note}`);
	}
	return lines;
}

function formatCounts(counts: Record<string, number>): string {
	const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
	return entries.length === 0 ? "none" : entries.map(([key, count]) => `${key} ${count}`).join(", ");
}

/** The report as text. `verbose` lists the `same` items too; otherwise they are only counted. */
export function formatShadowDiffReport(
	report: ShadowDiffReport,
	options: { verbose?: boolean; issues?: readonly string[] } = {},
): string {
	const lines = [
		`Shadow diff for ${report.workspaceId} (kit ${report.kitName}), ${report.since} to ${report.until}`,
		...(options.issues ?? []).map((issue) => `  warning: ${issue}`),
	];
	for (const category of Object.keys(CATEGORY_TITLES) as ShadowDiffCategory[]) {
		const items = report.items.filter((item) => item.category === category);
		const summary = STATUS_ORDER.map(
			(status) => [status, items.filter((item) => item.status === status).length] as const,
		)
			.filter(([, count]) => count > 0)
			.map(([status, count]) => `${count} ${STATUS_LABELS[status].toLowerCase()}`)
			.join(", ");
		lines.push("", `${CATEGORY_TITLES[category]}: ${summary || "nothing to compare"}`);
		for (const item of items) {
			if (options.verbose || item.status !== "same") {
				lines.push(...formatItem(item));
			}
		}
	}
	lines.push(
		"",
		`Legacy actions in the window: ${formatCounts(report.counts.legacy)}`,
		`Pipeline records in the window (stage:outcome): ${formatCounts(report.counts.pipeline)}`,
		"",
		report.unexplained === 0
			? "No unexplained differences."
			: `${report.unexplained} unexplained difference(s) (DIFF, LEGACY ONLY, PIPELINE ONLY).`,
	);
	return `${lines.join("\n")}\n`;
}
