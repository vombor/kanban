import { randomUUID } from "node:crypto";
import type { RuntimeTaskInputDeliveryResponse } from "../core/api-contract";
import type { ObjectiveAdmissionAccounting } from "../core/objective-admission";

/** Reserve only at imminent delivery, not while provider capacity or the user's draft holds input. */
export async function accountObjectiveInput(input: {
	accounting: ObjectiveAdmissionAccounting;
	workspaceId: string;
	taskId: string;
	deliver: () => Promise<RuntimeTaskInputDeliveryResponse>;
}): Promise<RuntimeTaskInputDeliveryResponse> {
	let row: Awaited<ReturnType<ObjectiveAdmissionAccounting["reserve"]>>;
	try {
		row = await input.accounting.reserve(input.workspaceId, input.taskId, randomUUID(), "input");
	} catch {
		return {
			ok: false,
			status: "busy",
			evidence: null,
			enterAttempts: 0,
			summary: null,
			error: "Objective admission/accounting is held or unavailable; nothing was typed. Inspect this project's objective controls.",
		};
	}
	if (row?.duplicate)
		return {
			ok: false,
			status: "busy",
			evidence: null,
			enterAttempts: 0,
			summary: null,
			error: "Objective input already has a retained receipt; no input was replayed.",
		};
	try {
		const result = await input.deliver();
		if (row) {
			const none = ["busy", "user_typing", "queued", "no_session"].includes(result.status);
			const confirmed =
				(result.evidence === "hook" || result.evidence === "state") && result.summary?.state === "running";
			await input.accounting.settle(
				input.workspaceId,
				row.id,
				none ? "released" : confirmed ? "started" : "uncertain",
				confirmed ? (result.summary?.stateChangedAt ?? null) : null,
			);
		}
		return result;
	} catch (error) {
		if (row) await input.accounting.settle(input.workspaceId, row.id, "uncertain").catch(() => {});
		throw error;
	}
}
