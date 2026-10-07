import type { Command } from "commander";

import { setKanbanRuntimePort } from "../core/runtime-endpoint";
import { getDefaultKanbanHomePath, getLegacyKanbanHomePath, resolveKanbanHome } from "../state/kanban-home";
import { type HomeMigratePlan, type HomeMigrateResult, runKanbanHomeMigration } from "../state/kanban-home-migrate";

interface HomeMigrateCommandOptions {
	from?: string;
	to?: string;
	dryRun?: boolean;
	worktrees?: boolean;
	json?: boolean;
}

type RootPortOption = { mode: "fixed"; value: number } | { mode: "auto" };

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

/** `--home` / KANBAN_HOME name the target explicitly; otherwise the fresh-install home (~/.kanban). */
function getDefaultTargetPath(): string {
	const resolution = resolveKanbanHome();
	return resolution.source === "flag" || resolution.source === "env"
		? resolution.homePath
		: getDefaultKanbanHomePath();
}

function countBy<T extends string>(values: T[]): string {
	const counts = new Map<T, number>();
	for (const value of values) {
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return [...counts].map(([value, count]) => `${count} ${value}`).join(", ") || "none";
}

function formatPlan(plan: HomeMigratePlan): string[] {
	const lines = [`From: ${plan.fromPath}`, `To:   ${plan.toPath}`];
	lines.push(`Files: ${countBy(plan.files.map((file) => file.action))}`);
	for (const file of plan.files.filter((step) => step.action === "keep-target")) {
		lines.push(`  keep-target ${file.path} (differs; the target's copy is kept)`);
	}
	lines.push(`config.json: ${plan.config.action} ("home": ${String(plan.config.config.home)})`);
	for (const key of plan.config.keptTargetKeys) {
		lines.push(`  keeps the target's ${key}`);
	}
	lines.push(`Worktrees root: ${plan.worktreesRootPath}`);
	lines.push(`Legacy worktree roots (read-only): ${plan.legacyWorktreeRootPaths.join(", ") || "none"}`);
	if (plan.ignoredEntries.length > 0) {
		lines.push(`Not copied (not Kanban home state): ${plan.ignoredEntries.join(", ")}`);
	}
	for (const worktree of plan.worktrees) {
		lines.push(
			worktree.action === "move"
				? `  move ${worktree.from} -> ${worktree.to}`
				: worktree.action === "relink"
					? `  relink session ${worktree.taskId}: ${worktree.from} -> ${worktree.to} (moved by an earlier run)`
					: `  skip ${worktree.from} (${worktree.reason})`,
		);
	}
	lines.push(`Server probe: ${plan.probedOrigin} (set with --port or KANBAN_RUNTIME_PORT)`);
	return lines;
}

function formatResult(result: HomeMigrateResult, dryRun: boolean): string[] {
	const { plan } = result;
	const lines = formatPlan(plan);
	if (plan.blockers.length > 0) {
		lines.push("", "Refusing to migrate:", ...plan.blockers.map((blocker) => `  - ${blocker}`));
		return lines;
	}
	if (plan.upToDate) {
		lines.push("", `Nothing to do: ${plan.toPath} is already migrated.`);
		return lines;
	}
	if (dryRun) {
		lines.push("", `Dry run: nothing written. A run writes the backup ${plan.backupPath} first.`);
		return lines;
	}
	lines.push("", `Backup: ${result.backupPath}`);
	for (const worktree of result.worktrees.filter((step) => step.error)) {
		lines.push(`  worktree ${worktree.taskId}: ${worktree.error}`);
	}
	lines.push(
		`Migrated. ${plan.toPath} is now an initialized Kanban home. ${plan.fromPath} is unchanged; once the new home works,`,
		`rename it (for example to ${plan.fromPath}.migrated-<ts>) rather than deleting it.`,
	);
	return lines;
}

export function registerHomeCommand(program: Command): void {
	const home = program.command("home").description("Manage the Kanban home (board state, config, worktrees).");
	home
		.command("migrate")
		.description(
			"Copy board state from the legacy home into the Kanban home and mark it. Refuses while a Kanban server runs.",
		)
		.option("--from <dir>", `Source home (default: ${getLegacyKanbanHomePath()}).`)
		.option("--to <dir>", "Target home (default: --home or KANBAN_HOME, else the fresh-install home).")
		.option("--dry-run", "Print the plan only.")
		.option("--worktrees", "Also move worktrees of idle (Backlog/Done) cards into the target's worktrees root.")
		.option("--json", "Print the result as JSON.")
		.addHelpText(
			"after",
			"\nThe running-server probe asks the runtime port: kanban --port <number> (KANBAN_RUNTIME_PORT, else 3484).",
		)
		.action(async (options: HomeMigrateCommandOptions, command: Command) => {
			try {
				// `--port` is the root option (commander parses it there even after the subcommand).
				const { port } = command.optsWithGlobals<{ port?: RootPortOption }>();
				if (port?.mode === "fixed") {
					setKanbanRuntimePort(port.value);
				}
				const result = await runKanbanHomeMigration({
					fromPath: options.from,
					toPath: options.to ?? getDefaultTargetPath(),
					dryRun: options.dryRun === true,
					moveWorktrees: options.worktrees === true,
				});
				const failed = result.plan.blockers.length > 0 || result.worktrees.some((worktree) => worktree.error);
				if (options.json) {
					process.stdout.write(`${JSON.stringify({ ok: !failed, ...result }, null, 2)}\n`);
				} else {
					process.stdout.write(`${formatResult(result, options.dryRun === true).join("\n")}\n`);
				}
				if (failed) {
					process.exitCode = 1;
				}
			} catch (error) {
				process.stderr.write(`Home migrate failed: ${toErrorMessage(error)}\n`);
				process.exitCode = 1;
			}
		});
}
