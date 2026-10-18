import { randomUUID } from "node:crypto";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { ObjectiveAdmissionAccounting } from "../core/objective-admission";

/** Split TUI API submissions are gated before every chunk, and conservatively reserved before any Enter. */
export async function accountObjectiveRawInput(input: {
	accounting: ObjectiveAdmissionAccounting;
	workspaceId: string;
	taskId: string;
	text: string;
	write: () => RuntimeTaskSessionSummary | null;
}): Promise<RuntimeTaskSessionSummary | null> {
	const decision = await input.accounting.check?.(input.workspaceId, input.taskId, "input");
	if (decision && !decision.allowed)
		throw new Error(`Objective admission held (${decision.reason}); nothing was typed.`);
	const row =
		decision?.bound && /[\r\n]/u.test(input.text)
			? await input.accounting.reserve(input.workspaceId, input.taskId, randomUUID(), "input")
			: null;
	try {
		const summary = input.write();
		// A physical write proves neither a submitted model prompt nor acceptance. Retain uncertainty until native facts/user acknowledgement.
		if (row) await input.accounting.settle(input.workspaceId, row.id, summary ? "uncertain" : "released");
		return summary;
	} catch (error) {
		if (row) await input.accounting.settle(input.workspaceId, row.id, "uncertain").catch(() => {});
		throw error;
	}
}
