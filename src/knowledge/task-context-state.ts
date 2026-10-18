import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { renameDurably, writeFileSynced } from "../fs/durable-file";
import {
	executionTaskIdSchema,
	type TaskKnowledgeContext,
	taskContextStartReservationSchema,
	taskKnowledgeContextSchema,
} from "../trpc/knowledge-execution-contract";
import { hashKnowledgeContent, readKnowledgeFile } from "./content-store";
import { KnowledgeError } from "./knowledge-error";

export const taskContextStateSchema = z
	.object({
		version: z.literal(1),
		tasks: z.record(executionTaskIdSchema, z.array(taskKnowledgeContextSchema).min(1).max(100)),
		starts: z.record(executionTaskIdSchema, taskContextStartReservationSchema).optional(),
	})
	.strict();
export type TaskContextState = z.infer<typeof taskContextStateSchema>;
export function taskContextDigest(context: Omit<TaskKnowledgeContext, "revision" | "attachedAt">): string {
	return hashKnowledgeContent(JSON.stringify(context));
}
export function validateTaskContextState(state: TaskContextState): void {
	if (Object.keys(state.tasks).length > 2000)
		throw new KnowledgeError("PRECONDITION_FAILED", "Task-context history ceiling reached; no history was evicted.");
	const requests = new Set<string>();
	for (const [taskId, history] of Object.entries(state.tasks)) {
		let previous: TaskKnowledgeContext | undefined;
		for (const context of history) {
			const { revision, attachedAt, ...definition } = context;
			if (context.taskId !== taskId || taskContextDigest(definition) !== revision)
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"Retained task-context identity failed its immutable revision check.",
				);
			const adoption = context.adoption;
			if (!previous && adoption)
				throw new KnowledgeError("PRECONDITION_FAILED", "Task-context adoption has no original reviewed handoff.");
			if (previous) {
				if (
					!adoption ||
					adoption.parentRevision !== previous.revision ||
					context.bundleRevision !== previous.bundleRevision ||
					context.planTaskId !== previous.planTaskId ||
					adoption.at !== attachedAt ||
					requests.has(adoption.requestId)
				)
					throw new KnowledgeError("PRECONDITION_FAILED", "Task-context adoption lineage or receipt is damaged.");
				const original = previous.documents.find((document) => document.id === adoption.documentId),
					replacement = context.documents.find((document) => document.id === adoption.documentId);
				if (
					!original ||
					!replacement ||
					original.revision !== adoption.previousRevision ||
					replacement.revision !== adoption.targetRevision ||
					original.revision === replacement.revision ||
					context.documents.length !== previous.documents.length ||
					previous.documents.some(
						(document) =>
							document.id !== adoption.documentId &&
							!context.documents.some((item) => JSON.stringify(item) === JSON.stringify(document)),
					)
				)
					throw new KnowledgeError(
						"PRECONDITION_FAILED",
						"An adoption changed more than its explicit reference revision.",
					);
				requests.add(adoption.requestId);
			}
			previous = context;
		}
		const reservation = state.starts?.[taskId];
		if (reservation && reservation.contextRevision !== history.at(-1)?.revision)
			throw new KnowledgeError(
				"PRECONDITION_FAILED",
				"Context changed after physical-start reservation; restore its history.",
			);
	}
	if (Object.keys(state.starts ?? {}).some((taskId) => !Object.hasOwn(state.tasks, taskId)))
		throw new KnowledgeError("PRECONDITION_FAILED", "A retained physical-start reservation lost its task context.");
}
export async function readTaskContextState(file: string): Promise<TaskContextState> {
	let text: string;
	try {
		text = await readKnowledgeFile(file, 8 * 1024 * 1024);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return { version: 1, tasks: {} };
		throw new KnowledgeError(
			"PRECONDITION_FAILED",
			"Task knowledge context is unreadable; retained pins were not discarded.",
		);
	}
	let state: TaskContextState;
	try {
		state = taskContextStateSchema.parse(JSON.parse(text));
	} catch {
		throw new KnowledgeError(
			"PRECONDITION_FAILED",
			"Task knowledge context is damaged or unsupported; restore it before writing.",
		);
	}
	validateTaskContextState(state);
	return state;
}
export async function writeTaskContextState(file: string, state: TaskContextState): Promise<void> {
	validateTaskContextState(state);
	const text = JSON.stringify(taskContextStateSchema.parse(state));
	if (Buffer.byteLength(text) > 8 * 1024 * 1024)
		throw new KnowledgeError(
			"PRECONDITION_FAILED",
			"Task-context history ceiling reached; no pin/history was evicted.",
		);
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFileSynced(temporary, text, { mode: 0o600, flag: "wx" });
		await renameDurably(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
}
