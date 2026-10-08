// `kanban doctor`'s findings: one per check, with the command that fixes it, and for the safe fixes a function
// `--fix` runs. Ported from the legacy `kit check` (one line per issue) and `kit switch-check` (PASS/WARN/FAIL).

/** `fail`: something is broken or two owners act on the same thing. `info`: what is configured, no action. */
export type DoctorLevel = "pass" | "info" | "warn" | "fail";

export type DoctorArea =
	| "home"
	| "project"
	| "trust"
	| "sections"
	| "hooks"
	| "setup"
	| "owner"
	| "guardrails"
	| "isolation"
	| "issues"
	| "deep";

export interface DoctorFinding {
	level: DoctorLevel;
	area: DoctorArea;
	message: string;
	/** The command that fixes it (also shown when `--fix` would run `fix`). */
	hint?: string;
	/** A safe fix `kanban doctor --fix` runs. Returns lines about what it did. */
	fix?: () => Promise<string[]>;
}

export interface DoctorFixOutcome {
	message: string;
	lines: string[];
	error: string | null;
}

export interface DoctorReport {
	findings: DoctorFinding[];
	fixes: DoctorFixOutcome[];
}

const LEVEL_LABELS: Record<DoctorLevel, string> = { pass: "PASS", info: "INFO", warn: "WARN", fail: "FAIL" };

export function countDoctorLevels(findings: DoctorFinding[]): Record<DoctorLevel, number> {
	const counts: Record<DoctorLevel, number> = { pass: 0, info: 0, warn: 0, fail: 0 };
	for (const finding of findings) {
		counts[finding.level] += 1;
	}
	return counts;
}

/** Text output: every finding except passes (all of them with `verbose`), then the fixes, then a summary line. */
export function formatDoctorReport(report: DoctorReport, options: { verbose: boolean; fix: boolean }): string[] {
	const lines: string[] = [];
	for (const finding of report.findings) {
		if (finding.level === "pass" && !options.verbose) {
			continue;
		}
		const hint = finding.hint
			? ` → ${finding.fix && !options.fix ? `${finding.hint} (or kanban doctor --fix)` : finding.hint}`
			: "";
		lines.push(`${LEVEL_LABELS[finding.level].padEnd(4)} ${finding.area}: ${finding.message}${hint}`);
	}
	for (const fix of report.fixes) {
		lines.push(
			fix.error
				? `fix failed: ${fix.message}: ${fix.error}`
				: `fixed: ${fix.message}${fix.lines.length ? ` (${fix.lines.join("; ")})` : ""}`,
		);
	}
	const counts = countDoctorLevels(report.findings);
	lines.push(
		`${report.findings.length} checks: ${counts.fail} fail, ${counts.warn} warn, ${counts.info} info, ${counts.pass} pass${report.fixes.length > 0 ? `; ${report.fixes.filter((fix) => !fix.error).length} fixed` : ""}`,
	);
	return lines;
}

/** JSON output: the findings without their fix functions. */
export function toDoctorJson(report: DoctorReport): {
	findings: Array<Omit<DoctorFinding, "fix"> & { fixable: boolean }>;
	fixes: DoctorFixOutcome[];
	counts: Record<DoctorLevel, number>;
} {
	return {
		findings: report.findings.map(({ fix, ...finding }) => ({ ...finding, fixable: fix !== undefined })),
		fixes: report.fixes,
		counts: countDoctorLevels(report.findings),
	};
}
