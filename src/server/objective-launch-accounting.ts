import { randomUUID } from "node:crypto";
import type { RuntimeTaskSessionStartResponse } from "../core/api-contract";
import type { ObjectiveAdmissionAccounting } from "../core/objective-admission";

/** Provider dispatch still owns capacity, validity and authorization. This only records the imminent own turn. */
export async function accountObjectiveLaunch(input: {
	accounting: ObjectiveAdmissionAccounting;
	workspaceId: string;
	taskId: string;
	requestId?: string;
	start: () => Promise<RuntimeTaskSessionStartResponse>;
}): Promise<RuntimeTaskSessionStartResponse> {
	const row = await input.accounting.reserve(
		input.workspaceId,
		input.taskId,
		input.requestId ?? randomUUID(),
		"start",
	);
	if (row?.duplicate)
		return {
			ok: false,
			summary: null,
			error: "This objective start already has a durable admission receipt; inspect its outcome instead of replaying the intent.",
		};
	try {
		const result = await input.start();
		if (row)
			await input.accounting.settle(
				input.workspaceId,
				row.id,
				result.ok && result.summary ? "started" : "uncertain",
				result.summary?.stateChangedAt ?? result.summary?.startedAt ?? null,
			);
		return result;
	} catch (error) {
		if (row) await input.accounting.settle(input.workspaceId, row.id, "uncertain").catch(() => {});
		throw error;
	}
}
