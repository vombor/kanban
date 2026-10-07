#!/usr/bin/env -S npx tsx
// The cutover's shadow diff (docs/fork/kit-merge-plan.md §8.4 step 1, docs/team/RUNBOOK.md "Shadow day"): compares
// what the pipeline decided on a shadow workspace with what the legacy kit's autoland did on the same board.
// Read-only. Replaces the legacy kit's test/equivalence.sh for the port.
//
//   npx tsx scripts/pipeline-shadow-diff.ts [--workspace <id>]... [--since <iso|24h|90m>] [--until <iso>]
//       [--window-min 10] [--legacy-log <path>] [--home <dir>] [--json] [--verbose]
//
// Exit code: 0 no unexplained difference, 1 some, 2 bad arguments or unreadable inputs.
import { parseArgs } from "node:util";

import { runShadowDiff } from "../src/pipeline/shadow-diff/run-shadow-diff";
import { setKanbanHomeOverride } from "../src/state/kanban-home";

const USAGE =
	"usage: pipeline-shadow-diff [--workspace <id>]... [--since <iso|24h|90m>] [--until <iso>] [--window-min N] [--legacy-log <path>] [--home <dir>] [--json] [--verbose]";

function parseTime(value: string, now: number): number {
	const relative = /^(\d+(?:\.\d+)?)([mhd])$/u.exec(value);
	if (relative) {
		const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"];
		return now - Number(relative[1]) * unit;
	}
	const at = Date.parse(value);
	if (Number.isNaN(at)) {
		throw new Error(`not a time: ${value} (an ISO time, or an age such as 24h, 90m, 2d)`);
	}
	return at;
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			workspace: { type: "string", multiple: true, default: [] },
			since: { type: "string", default: "24h" },
			until: { type: "string" },
			"window-min": { type: "string", default: "10" },
			"legacy-log": { type: "string" },
			home: { type: "string" },
			json: { type: "boolean", default: false },
			verbose: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	if (values.home) {
		setKanbanHomeOverride(values.home);
	}
	const now = Date.now();
	const windowMin = Number(values["window-min"]);
	if (!Number.isFinite(windowMin) || windowMin < 0) {
		throw new Error(`--window-min must be a number of minutes, not ${values["window-min"]}`);
	}
	const result = await runShadowDiff({
		workspaceIds: values.workspace,
		since: parseTime(values.since, now),
		until: values.until ? parseTime(values.until, now) : now,
		windowMs: windowMin * 60_000,
		legacyLogPath: values["legacy-log"],
		json: values.json,
		verbose: values.verbose,
	});
	process.stdout.write(result.output);
	return result.exitCode;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`pipeline-shadow-diff: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
		process.exitCode = 2;
	},
);
