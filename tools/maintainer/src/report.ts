import type { MaintenanceJournal } from "./contracts";

export function maintenanceReport(journal: MaintenanceJournal): string {
	const check = journal.checks.at(-1);
	const header = `Maintenance revision ${journal.revision}; last check ${check ? `${check.day}: ${check.outcome} at ${check.at}${check.source === "legacy_no_work" ? " (retained legacy receipt)" : ""}` : "none"}.`;
	const jobs = journal.jobs
		.slice(-20)
		.reverse()
		.map((job) => {
			const phase = job.workerStage ? ` / ${job.workerStage} (worker-reported)` : "";
			const evidence =
				job.state === "completed"
					? `; verified ${job.commits.length} commit(s), ${job.ciUrls.length} CI receipt(s)`
					: "";
			return `${job.id}: ${job.state}${phase}; ${job.repository} ${job.issues.map((item) => `#${item.number}`).join(", ")}${evidence}${job.reason ? `; ${job.reason}` : ""}`;
		});
	return [
		header,
		...jobs,
		"No automatic admission retries, model/session changes, release or live-deployment authority.",
	].join("\n");
}
