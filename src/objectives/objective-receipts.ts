// Existing checks/QA/landing owners retain receipts beside their authoritative state BEFORE collecting them.
// Reconciliation replays these exact receipts after a crash; it never manufactures a new binding on result arrival.
import { z } from "zod";
import {
	type ObjectiveEvidence,
	type ObjectiveEvidenceOwner,
	objectiveBindingSchema,
	objectiveEvidenceSchema,
	objectiveLineageSchema,
} from "../core/objective-evidence";
import type { ChecksResult } from "../pipeline/checks";
import type { PipelineCardState, PipelineWorkspaceState } from "../pipeline/pipeline-state";
import { objectiveDigest } from "./objective-identity";
import type { ObjectiveStore } from "./objective-store";

const receiptsSchema = z.array(objectiveEvidenceSchema).max(4000);
const qaLineageSchema = z.object({
	objectiveBinding: objectiveBindingSchema,
	reviewsTaskId: z.string().min(1).max(80),
	createdAt: z.number().finite(),
	evidenceOnly: z.boolean().optional(),
});
export function retainObjectiveReceipt(
	entry: PipelineCardState | undefined,
	receipt: ObjectiveEvidence,
): PipelineCardState {
	const receipts = receiptsSchema.parse(entry?.objectiveReceipts ?? []);
	const existing = receipts.find((item) => item.id === receipt.id);
	if (existing && JSON.stringify(existing) !== JSON.stringify(receipt))
		throw new Error("Objective owner receipt identity conflicts; evidence retained.");
	if (!existing) receipts.push(receipt);
	return { ...entry, objectiveReceipts: receiptsSchema.parse(receipts) };
}

export function checksObjectiveReceipt(result: ChecksResult): ObjectiveEvidence | null {
	const binding = result.request.objectiveBinding;
	if (!binding) return null;
	const scripts = result.request.scripts.map((name) => {
		const step = result.steps.find((step) => step.name === name && !step.advisory);
		const harness = result.harness || step?.harness === true || step?.skipped === "harness";
		return {
			name,
			harness,
			status:
				!step || step.skipped || harness ? ("unknown" as const) : step.ok ? ("pass" as const) : ("fail" as const),
		};
	});
	return objectiveEvidenceSchema.parse({
		id: objectiveDigest(
			JSON.stringify(["checks", binding, result.request.taskId, result.request.snapshot, result.startedAt]),
		),
		kind: "checks",
		binding,
		taskId: result.request.taskId,
		snapshot: result.request.snapshot,
		at: new Date(result.finishedAt).toISOString(),
		scripts,
	});
}

export function createObjectiveEvidenceOwner(store: ObjectiveStore): ObjectiveEvidenceOwner {
	return {
		attach: async (workspaceId, input) => await store.attach(workspaceId, input),
		capture: async (workspaceId, taskId) => {
			const binding = await store.binding(workspaceId, taskId);
			return binding
				? { binding, requirements: await store.readRequirements(workspaceId, binding.requirementsHash) }
				: null;
		},
		record: async (workspaceId, receipt) => await store.record(workspaceId, receipt),
	};
}

export async function replayObjectiveReceipts(
	store: ObjectiveStore,
	workspaceId: string,
	state: PipelineWorkspaceState,
): Promise<void> {
	const objectives = (await store.read(workspaceId)).objectives;
	// All explicit parents commit before their descendants are collected, regardless of object insertion order.
	const pending = Object.entries(state.cards).flatMap(([taskId, entry]) => {
		if (entry.objectiveLineage !== undefined) {
			const link = objectiveLineageSchema.parse(entry.objectiveLineage);
			if (link.taskId !== taskId) throw new Error("Retained objective lineage names another task.");
			return [link];
		}
		if (entry.qaGate && typeof entry.qaGate === "object" && "objectiveBinding" in entry.qaGate) {
			const qa = qaLineageSchema.parse(entry.qaGate);
			return qa.evidenceOnly
				? []
				: [
						objectiveLineageSchema.parse({
							binding: qa.objectiveBinding,
							kind: "qa",
							taskId,
							parentTaskId: qa.reviewsTaskId,
							at: new Date(qa.createdAt).toISOString(),
						}),
					];
		}
		return [];
	});
	const attached = new Set(
		objectives.flatMap((objective) => objective.tasks.map((task) => `${objective.id}:${task.taskId}`)),
	);
	while (pending.length) {
		const index = pending.findIndex((link) => attached.has(`${link.binding.objectiveId}:${link.parentTaskId}`));
		if (index < 0) throw new Error("Retained objective lineage has a missing/cyclic parent; no work was replayed.");
		const [link] = pending.splice(index, 1);
		if (!link) throw new Error("Missing lineage receipt.");
		await store.attach(workspaceId, link);
		attached.add(`${link.binding.objectiveId}:${link.taskId}`);
	}
	for (const entry of Object.values(state.cards)) {
		for (const receipt of receiptsSchema.parse(entry.objectiveReceipts ?? [])) {
			const objective = objectives.find((objective) => objective.id === receipt.binding.objectiveId);
			if (!objective)
				throw new Error("An objective owner receipt has no objective; preserve state before restoring.");
			const existing = objective.evidence.find((evidence) => evidence.id === receipt.id);
			if (!existing || JSON.stringify(existing) !== JSON.stringify(receipt))
				await store.record(workspaceId, receipt);
		}
	}
}

export function buildObjectiveQaNote(capture: Awaited<ReturnType<ObjectiveEvidenceOwner["capture"]>>): string | null {
	if (!capture) return null;
	return [
		`PINNED OBJECTIVE ${capture.binding.objectiveId} (requirements SHA-256 ${capture.binding.requirementsHash}; policy ${capture.binding.policyHash}).`,
		"Evaluate these user-owned acceptance requirements in addition to the card requirements. A claim, Review or Done is not proof. Preserve missing evidence and blocking findings in the ordinary verdict; do not approve requirements, change limits, reopen benchmarks or substitute models.",
		...capture.requirements.split("\n").map((line) => `> ${line}`),
	].join("\n");
}
