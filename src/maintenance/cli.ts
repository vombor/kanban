// Host administration only: intentionally disconnected from the pod's board/pipeline/recovery router.
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { Command } from "commander";

import { createMaintenancePorts } from "./adapters";
import { type MaintenanceConfig, maintenanceConfigSchema } from "./contracts";
import { maintenanceReport } from "./report";
import { MaintenanceStore } from "./store";
import { MaintenanceSupervisor } from "./supervisor";

function assertHostOperatorContext(): void {
	if (process.env.KANBAN_SESSION_CREDENTIAL || existsSync("/run/.containerenv") || existsSync("/.dockerenv"))
		throw new Error("Host maintenance administration is unavailable to pod/card callers");
}

async function loadConfig(path: string): Promise<MaintenanceConfig> {
	const info = await lstat(path);
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		info.size > 32 * 1024 ||
		(info.mode & 0o022) !== 0 ||
		(process.getuid && info.uid !== process.getuid())
	)
		throw new Error("Maintenance config must be a bounded owner-written regular file");
	return maintenanceConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function localDay(now: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(now);
	return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
}

async function run() {
	const program = new Command()
		.name("kanban-maintenance")
		.description("Operator-configured host maintenance journal and supervisor; never a release/deployment agent")
		.requiredOption("--home <path>", "Explicit host-only canonical Kanban home, separate from live runtime data")
		.requiredOption("--config <path>", "Private operator-owned installation configuration")
		.option("--json", "Print bounded structured receipts instead of a concise report");
	for (const action of ["daily", "reconcile", "status", "preflight"] as const) {
		program.command(action).action(async () => {
			assertHostOperatorContext();
			const options = program.opts<{ home: string; config: string; json?: boolean }>();
			const config = await loadConfig(options.config);
			// Explicit home mandatory; no accidental fallback to a pod or second installation's live home.
			const home = await realpath(options.home);
			const store = new MaintenanceStore(home);
			const ports = createMaintenancePorts(config);
			if (action === "preflight") {
				const issues = await ports.issues();
				await ports.validateTarget();
				const startingCommit = await ports.startingCommit();
				await store.read();
				process.stdout.write(
					`${JSON.stringify({
						status: "preflight",
						targetVerified: true,
						startingCommit,
						openIssues: issues.map((issue) => issue.number),
						inputQueued: false,
					})}\n`,
				);
				return;
			}
			const supervisor = new MaintenanceSupervisor(config, store, ports);
			const journal =
				action === "daily"
					? await supervisor.daily(localDay(new Date(), config.timezone))
					: action === "reconcile"
						? await supervisor.reconcile()
						: await store.read();
			process.stdout.write(
				`${
					options.json
						? JSON.stringify({
								revision: journal.revision,
								lastCheck: journal.checks.at(-1) ?? null,
								jobs: journal.jobs.slice(-20),
							})
						: maintenanceReport(journal)
				}\n`,
			);
		});
	}
	await program.parseAsync();
}

run().catch(() => {
	process.stderr.write(
		`${JSON.stringify({ status: "blocked", reason: "host_maintenance_unavailable_inspect_journal_no_mutation_replay" })}\n`,
	);
	process.exitCode = 1;
});
