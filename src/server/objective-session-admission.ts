import { randomUUID } from "node:crypto";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { ObjectiveAdmissionAccounting } from "../core/objective-admission";

/** Physical-session boundary: blank composers and manager restarts cannot bypass accounting. No authorization flag. */
export async function accountObjectiveSessionStart(input: {
	accounting: ObjectiveAdmissionAccounting;
	workspaceId: string;
	taskId: string;
	requestId?: string;
	start: () => Promise<RuntimeTaskSessionSummary>;
}): Promise<RuntimeTaskSessionSummary> {
	const row = await input.accounting.reserve(
		input.workspaceId,
		input.taskId,
		input.requestId ?? randomUUID(),
		"start",
	);
	if (row?.duplicate)
		throw new Error(
			"Objective start has a retained admission identity; inspect its outcome instead of replaying it.",
		);
	try {
		const summary = await input.start();
		if (row)
			await input.accounting.settle(
				input.workspaceId,
				row.id,
				"started",
				summary.stateChangedAt ?? summary.startedAt ?? null,
			);
		return summary;
	} catch (error) {
		if (row) await input.accounting.settle(input.workspaceId, row.id, "uncertain").catch(() => {});
		throw error;
	}
}
