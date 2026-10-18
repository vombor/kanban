import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type ObjectiveAdmissionAccounting, objectiveReservationSchema } from "../core/objective-admission";
import {
	type ObjectiveControlRequest,
	type ObjectiveCreate,
	type ObjectiveLimits,
	type ObjectiveManualLineage,
	objectiveSchema,
	type RuntimeObjective,
} from "../core/objective-contract";
import {
	type ObjectiveBinding,
	type ObjectiveEvidence,
	type ObjectiveLineage,
	objectiveBindingSchema,
	objectiveEvidenceSchema,
	objectiveLineageSchema,
} from "../core/objective-evidence";
import type { ObjectiveUsageRecord } from "../core/objective-usage";
import { renameDurably, writeFileSynced } from "../fs/durable-file";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getObjectivePaths } from "../state/kanban-home";
import { decideObjectiveAdmission, describeObjectiveAdmission, objectiveOverride } from "./objective-admission";
import { assessObjective } from "./objective-assessment";
import { type ObjectiveSessionObservation, observeObjectiveAttempts } from "./objective-attempts";
import { objectiveDigest } from "./objective-identity";
import { retainObjectiveUsage } from "./objective-usage";

export class ObjectiveError extends Error {
	constructor(
		readonly code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND" | "PRECONDITION_FAILED",
		message: string,
	) {
		super(message);
	}
}
const receiptSchema = z.object({ requestId: z.string().uuid(), digest: z.string(), objectiveId: z.string() }).strict();
export const objectiveStateSchema = z
	.object({
		version: z.literal(1),
		revision: z.number().int().nonnegative(),
		objectives: z.array(objectiveSchema).max(1000),
		receipts: z.array(receiptSchema).max(4000),
	})
	.strict()
	.superRefine((state, context) => {
		const objects = new Set<string>();
		const tasks = new Set<string>();
		const receipts = new Set<string>();
		for (const objective of state.objectives) {
			if (objects.has(objective.id)) context.addIssue({ code: "custom", message: "Duplicate objective identity." });
			objects.add(objective.id);
			for (const task of objective.tasks) {
				if (tasks.has(task.taskId))
					context.addIssue({ code: "custom", message: "Task belongs to multiple objectives." });
				tasks.add(task.taskId);
			}
		}
		for (const receipt of state.receipts) {
			if (receipts.has(receipt.requestId) || !objects.has(receipt.objectiveId))
				context.addIssue({ code: "custom", message: "Invalid objective mutation receipt identity." });
			receipts.add(receipt.requestId);
		}
	});
export type ObjectiveState = z.infer<typeof objectiveStateSchema>;
export { objectiveDigest } from "./objective-identity";

export interface ObjectiveStore extends ObjectiveAdmissionAccounting {
	check: NonNullable<ObjectiveAdmissionAccounting["check"]>;
	manualLineage(workspaceId: string, input: ObjectiveManualLineage): Promise<RuntimeObjective>;
	control(workspaceId: string, input: ObjectiveControlRequest): Promise<RuntimeObjective>;
	interruptReservations(workspaceId: string, before: number): Promise<void>;
	recordUsage(workspaceId: string, objectiveId: string, records: readonly ObjectiveUsageRecord[]): Promise<void>;
	attach(workspaceId: string, input: ObjectiveLineage): Promise<void>;
	observe(workspaceId: string, sessions: readonly ObjectiveSessionObservation[], complete?: boolean): Promise<void>;
	binding(workspaceId: string, taskId: string): Promise<ObjectiveBinding | null>;
	record(workspaceId: string, evidence: ObjectiveEvidence): Promise<void>;
	read(workspaceId: string): Promise<ObjectiveState>;
	readRequirements(workspaceId: string, hash: string): Promise<string>;
	create(workspaceId: string, input: ObjectiveCreate): Promise<RuntimeObjective>;
	setLimits(
		workspaceId: string,
		input: {
			requestId: string;
			id: string;
			expectedRevision: number;
			limits: ObjectiveLimits;
			acknowledgeAdmissionScope?: boolean;
		},
	): Promise<RuntimeObjective>;
}

export function createObjectiveStore(
	options: { home?: string; now?: () => Date; admissionScopeAvailable?: boolean } = {},
): ObjectiveStore {
	const now = options.now ?? (() => new Date());
	const paths = (id: string) => getObjectivePaths(id, options.home);
	const persist = async (workspaceId: string, state: ObjectiveState): Promise<void> => {
		const content = JSON.stringify(objectiveStateSchema.parse(state));
		if (Buffer.byteLength(content) > 16 * 1024 * 1024)
			throw new ObjectiveError(
				"PRECONDITION_FAILED",
				"Objective journal ceiling reached; no history was discarded.",
			);
		await lockedFileSystem.writeTextFileAtomic(paths(workspaceId).state, content, { lock: null });
	};
	const read = async (id: string): Promise<ObjectiveState> => {
		try {
			const root = await lstat(paths(id).root);
			if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Invalid objective directory");
			const info = await lstat(paths(id).state);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
				throw new Error("Invalid state file");
			return objectiveStateSchema.parse(JSON.parse(await readFile(paths(id).state, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, revision: 0, objectives: [], receipts: [] };
			throw new ObjectiveError(
				"PRECONDITION_FAILED",
				"Objective state is unreadable/corrupt; preserve it and restore before changing or admitting work.",
			);
		}
	};
	const change = async (
		workspaceId: string,
		requestId: string,
		digest: string,
		mutate: (state: ObjectiveState) => Promise<RuntimeObjective>,
	): Promise<RuntimeObjective> => {
		const path = paths(workspaceId);
		await mkdir(path.root, { recursive: true, mode: 0o700 });
		if ((await lstat(path.root)).isSymbolicLink())
			throw new ObjectiveError("PRECONDITION_FAILED", "Objective storage cannot be a symlink.");
		return await lockedFileSystem.withLock({ path: path.state }, async () => {
			const state = await read(workspaceId);
			const receipt = state.receipts.find((item) => item.requestId === requestId);
			if (receipt) {
				if (receipt.digest !== digest)
					throw new ObjectiveError("CONFLICT", "This request id already committed different objective data.");
				const objective = state.objectives.find((item) => item.id === receipt.objectiveId);
				if (!objective)
					throw new ObjectiveError("PRECONDITION_FAILED", "Objective retry receipt has no matching objective.");
				return objective;
			}
			if (state.receipts.length >= 4000)
				throw new ObjectiveError(
					"PRECONDITION_FAILED",
					"Objective receipt retention ceiling reached; history was not evicted.",
				);
			const objective = await mutate(state);
			state.receipts.push({ requestId, digest, objectiveId: objective.id });
			state.revision += 1;
			await persist(workspaceId, state);
			return objective;
		});
	};
	const store: ObjectiveStore = {
		check: async (workspaceId, taskId, kind) => {
			const objective = (await read(workspaceId)).objectives.find((item) =>
				item.tasks.some((task) => task.taskId === taskId),
			);
			if (!objective) return { bound: false, allowed: true, reason: null };
			await store.readRequirements(workspaceId, objective.requirementsHash);
			return decideObjectiveAdmission(
				objective,
				taskId,
				kind,
				now().getTime(),
				options.admissionScopeAvailable === true,
			);
		},
		manualLineage: async (workspaceId, input) =>
			change(workspaceId, input.requestId, objectiveDigest(JSON.stringify(input)), async (state) => {
				const objective = state.objectives.find((item) => item.id === input.id);
				if (!objective || objective.revision !== input.expectedRevision)
					throw new ObjectiveError(
						"CONFLICT",
						"Read the current objective revision before binding explicit task lineage.",
					);
				const parent = objective.tasks.find((task) => task.taskId === input.parentTaskId);
				if (!parent || parent.kind === "qa")
					throw new ObjectiveError("BAD_REQUEST", "Manual lineage needs this objective's implementation parent.");
				await store.readRequirements(workspaceId, objective.requirementsHash);
				if (
					new Set(input.taskIds).size !== input.taskIds.length ||
					state.objectives.some((item) => item.tasks.some((task) => input.taskIds.includes(task.taskId)))
				)
					throw new ObjectiveError("CONFLICT", "Manual lineage cannot overwrite or duplicate task membership.");
				const at = now().toISOString();
				for (const taskId of input.taskIds)
					objective.tasks.push({ taskId, kind: input.kind, parentTaskId: input.parentTaskId, attachedAt: at });
				Object.assign(objective, assessObjective(objective, at));
				objective.revision++;
				objective.updatedAt = at;
				return objective;
			}),
		control: async (workspaceId, input) =>
			change(workspaceId, input.requestId, objectiveDigest(JSON.stringify(input)), async (state) => {
				if (!options.admissionScopeAvailable)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						"Objective admission controls are unavailable on this runtime.",
					);
				const objective = state.objectives.find((item) => item.id === input.id);
				if (!objective || objective.revision !== input.expectedRevision)
					throw new ObjectiveError(
						"CONFLICT",
						"Read the current objective revision before changing user-owned admission controls.",
					);
				await store.readRequirements(workspaceId, objective.requirementsHash);
				if (objective.controls.length >= 4000)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						"Control history ceiling reached; no approval or history was evicted.",
					);
				if (
					input.action === "override" &&
					(!objective.tasks.some((task) => task.taskId === input.taskId) ||
						objectiveOverride(objective, input.taskId ?? "", input.kind ?? "start"))
				)
					throw new ObjectiveError(
						"CONFLICT",
						"One-admission override must target an own member with no outstanding matching override.",
					);
				if (
					input.action === "acknowledge" &&
					!objective.reservations.some(
						(row) => row.id === input.reservationId && (row.state === "uncertain" || row.state === "reserved"),
					)
				)
					throw new ObjectiveError(
						"BAD_REQUEST",
						"Only retained uncertain admissions may be acknowledged; no charge or acceptance is erased.",
					);
				const at = now().toISOString();
				objective.controls.push({
					controlId: input.controlId,
					revokedBy: null,
					id: input.requestId,
					at,
					action: input.action,
					reason: input.reason,
					taskId: input.taskId,
					kind: input.kind,
					reservationId: input.reservationId,
					requirementsHash: objective.requirementsHash,
					limitsHash: objectiveDigest(JSON.stringify(objective.limits)),
					usedBy: null,
				});
				if (input.action === "pause") objective.pausedByUser = true;
				if (input.action === "revoke") {
					const grant = objective.controls.find(
						(row) =>
							row.id === input.controlId &&
							row.action === "override" &&
							row.usedBy === null &&
							row.revokedBy === null,
					);
					if (!grant)
						throw new ObjectiveError(
							"BAD_REQUEST",
							"Only an unused own override may be revoked; consumed admissions and history are never refunded.",
						);
					grant.revokedBy = input.requestId;
				}
				if (input.action === "resume") objective.pausedByUser = false;
				Object.assign(objective, assessObjective(objective, at));
				objective.revision++;
				objective.updatedAt = at;
				return objective;
			}),
		interruptReservations: async (workspaceId, before) => {
			if (!(await read(workspaceId)).objectives.length) return;
			await lockedFileSystem.withLock({ path: paths(workspaceId).state }, async () => {
				const state = await read(workspaceId);
				let changed = false;
				for (const objective of state.objectives) {
					let touched = false;
					for (const row of objective.reservations) {
						if (row.state === "reserved" && Date.parse(row.at) < before) {
							row.state = "uncertain";
							touched = true;
						}
					}
					if (touched) {
						objective.revision += 1;
						objective.updatedAt = now().toISOString();
						changed = true;
					}
				}
				if (changed) {
					state.revision += 1;
					await persist(workspaceId, state);
				}
			});
		},
		reserve: async (workspaceId, taskId, id, kind) => {
			if (
				!(await read(workspaceId)).objectives.some((objective) =>
					objective.tasks.some((task) => task.taskId === taskId),
				)
			)
				return null;
			return await lockedFileSystem.withLock({ path: paths(workspaceId).state }, async () => {
				const state = await read(workspaceId);
				const objective = state.objectives.find((item) => item.tasks.some((task) => task.taskId === taskId));
				if (!objective)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						"Objective membership changed before admission accounting.",
					);
				await store.readRequirements(workspaceId, objective.requirementsHash);
				const old = state.objectives.flatMap((item) => item.reservations).find((row) => row.id === id);
				if (old) {
					if (!objective.reservations.includes(old) || old.taskId !== taskId || old.kind !== kind)
						throw new ObjectiveError("CONFLICT", "Admission identity already belongs to different work.");
					return { id, duplicate: true };
				}
				const decision = decideObjectiveAdmission(
					objective,
					taskId,
					kind,
					now().getTime(),
					options.admissionScopeAvailable === true,
				);
				if (!decision.allowed)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						`Objective admission held (${decision.reason}); inspect this project's objective controls. Nothing was started or typed.`,
					);
				if (objective.reservations.length >= 4000)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						"Admission receipt ceiling reached; uncertainty/history were retained.",
					);
				const at = now().toISOString();
				const report = describeObjectiveAdmission(objective, Date.parse(at));
				const override =
					objective.limits.mode === "enforce" &&
					report.some((reason) => reason !== "cost_unknown" || objective.limits.unknownCost === "hold")
						? objectiveOverride(objective, taskId, kind)
						: undefined;
				if (override) override.usedBy = id;
				objective.reservations.push(
					objectiveReservationSchema.parse({
						id,
						taskId,
						kind,
						requirementsHash: objective.requirementsHash,
						at,
						state: "reserved",
						startedAt: null,
						report,
					}),
				);
				objective.revision += 1;
				objective.updatedAt = at;
				state.revision += 1;
				await persist(workspaceId, state);
				return { id, duplicate: false };
			});
		},
		settle: async (workspaceId, id, outcome, startedAt = null) => {
			await lockedFileSystem.withLock({ path: paths(workspaceId).state }, async () => {
				const state = await read(workspaceId);
				const objective = state.objectives.find((item) => item.reservations.some((row) => row.id === id));
				const row = objective?.reservations.find((row) => row.id === id);
				if (!objective || !row)
					throw new ObjectiveError("NOT_FOUND", "Admission receipt was not found; no outcome can be invented.");
				if (row.state === outcome && row.startedAt === startedAt) return;
				if (row.state !== "reserved")
					throw new ObjectiveError(
						"CONFLICT",
						"Admission outcome already committed; inspect it before resolving uncertainty.",
					);
				row.state = outcome;
				row.startedAt = startedAt;
				objective.revision += 1;
				objective.updatedAt = now().toISOString();
				state.revision += 1;
				await persist(workspaceId, state);
			});
		},
		recordUsage: async (workspaceId, objectiveId, records) => {
			if (!records.length) return;
			await lockedFileSystem.withLock({ path: paths(workspaceId).state }, async () => {
				const state = await read(workspaceId);
				const objective = state.objectives.find((item) => item.id === objectiveId);
				if (!objective) throw new ObjectiveError("NOT_FOUND", "Objective usage has no matching owner.");
				await store.readRequirements(workspaceId, objective.requirementsHash);
				if (!retainObjectiveUsage(objective, records)) return;
				objective.revision += 1;
				objective.updatedAt = now().toISOString();
				state.revision += 1;
				await persist(workspaceId, state);
			});
		},
		attach: async (workspaceId, raw) => {
			const input = objectiveLineageSchema.parse(raw);
			await lockedFileSystem.withLock({ path: paths(workspaceId).state }, async () => {
				const state = await read(workspaceId);
				const objective = state.objectives.find(
					(item) =>
						item.id === input.binding.objectiveId &&
						item.tasks.some((task) => task.taskId === input.parentTaskId),
				);
				if (
					!objective ||
					objective.requirementsHash !== input.binding.requirementsHash ||
					objectiveDigest(JSON.stringify(objective.policy)) !== input.binding.policyHash
				)
					throw new ObjectiveError("PRECONDITION_FAILED", "Task lineage has no matching pinned objective parent.");
				await store.readRequirements(workspaceId, objective.requirementsHash);
				if (
					input.taskId === input.parentTaskId ||
					objective.tasks.find((task) => task.taskId === input.parentTaskId)?.kind === "qa"
				)
					throw new ObjectiveError(
						"BAD_REQUEST",
						"Derived task lineage requires an implementation parent, never itself or a QA task.",
					);
				const existing = state.objectives
					.flatMap((item) => item.tasks)
					.find((task) => task.taskId === input.taskId);
				if (existing) {
					if (
						!objective.tasks.includes(existing) ||
						existing.kind !== input.kind ||
						existing.parentTaskId !== input.parentTaskId ||
						existing.attachedAt !== input.at
					)
						throw new ObjectiveError("CONFLICT", "Task already has different objective lineage.");
					return;
				}
				objective.tasks.push({
					taskId: input.taskId,
					kind: input.kind,
					parentTaskId: input.parentTaskId,
					attachedAt: input.at,
				});
				Object.assign(objective, assessObjective(objective, now().toISOString()));
				objective.revision += 1;
				objective.updatedAt = now().toISOString();
				state.revision += 1;
				await persist(workspaceId, state);
			});
		},
		observe: async (workspaceId, sessions, complete = true) => {
			// Do not initialize empty objective files on projects that never opted into native objectives.
			if (!(await read(workspaceId)).objectives.length) return;
			await lockedFileSystem.withLock({ path: paths(workspaceId).state }, async () => {
				const state = await read(workspaceId);
				let changed = false;
				for (const objective of state.objectives) {
					const before = JSON.stringify(objective);
					await store.readRequirements(workspaceId, objective.requirementsHash);
					observeObjectiveAttempts(objective, sessions, complete);
					for (const reservation of objective.reservations) {
						if (reservation.state !== "uncertain") continue;
						const session = sessions.find(
							(item) =>
								item.taskId === reservation.taskId &&
								item.live &&
								item.state === "running" &&
								item.submitted !== false &&
								Math.max(item.stateChangedAt ?? 0, item.submittedAt ?? 0) >= Date.parse(reservation.at),
						);
						if (session) {
							reservation.state = "started";
							reservation.startedAt = Math.max(session.stateChangedAt ?? 0, session.submittedAt ?? 0);
						}
					}
					Object.assign(objective, assessObjective(objective, now().toISOString()));
					if (JSON.stringify(objective) !== before) {
						objective.revision += 1;
						objective.updatedAt = now().toISOString();
						changed = true;
					}
				}
				if (changed) {
					state.revision += 1;
					await persist(workspaceId, state);
				}
			});
		},
		binding: async (workspaceId, taskId) => {
			const objective = (await read(workspaceId)).objectives.find((item) =>
				item.tasks.some((task) => task.taskId === taskId),
			);
			return objective
				? objectiveBindingSchema.parse({
						objectiveId: objective.id,
						requirementsHash: objective.requirementsHash,
						policyHash: objectiveDigest(JSON.stringify(objective.policy)),
					})
				: null;
		},
		record: async (workspaceId, input) => {
			const evidence = objectiveEvidenceSchema.parse(input);
			const path = paths(workspaceId);
			await lockedFileSystem.withLock({ path: path.state }, async () => {
				const state = await read(workspaceId);
				const objective = state.objectives.find(
					(item) =>
						item.id === evidence.binding.objectiveId &&
						item.tasks.some((task) => task.taskId === evidence.taskId),
				);
				if (!objective)
					throw new ObjectiveError("PRECONDITION_FAILED", "Evidence has no matching objective task membership.");
				await store.readRequirements(workspaceId, objective.requirementsHash);
				if (
					Date.parse(evidence.at) <
					Math.max(
						Date.parse(objective.createdAt),
						Date.parse(
							objective.tasks.find((task) => task.taskId === evidence.taskId)?.attachedAt ?? objective.createdAt,
						),
					)
				)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						"Evidence predates the objective requirements; historical acceptance cannot be adopted.",
					);
				const existing = objective.evidence.find((item) => item.id === evidence.id);
				if (existing) {
					if (JSON.stringify(existing) !== JSON.stringify(evidence))
						throw new ObjectiveError("CONFLICT", "An evidence identity already records different facts.");
					return;
				}
				if (objective.evidence.length >= 4000)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						"Objective evidence ceiling reached; history was retained.",
					);
				objective.evidence.push(evidence);
				const at = now().toISOString();
				Object.assign(objective, assessObjective(objective, at));
				objective.revision += 1;
				objective.updatedAt = at;
				state.revision += 1;
				await persist(workspaceId, state);
			});
		},
		read,
		readRequirements: async (workspaceId, hash) => {
			if (!/^[a-f0-9]{64}$/u.test(hash)) throw new ObjectiveError("BAD_REQUEST", "Invalid requirement revision.");
			const path = join(paths(workspaceId).requirements, `${hash}.md`);
			try {
				const directory = await lstat(paths(workspaceId).requirements);
				if (!directory.isDirectory() || directory.isSymbolicLink())
					throw new Error("Invalid requirements directory");
				const info = await lstat(path);
				if (!info.isFile() || info.isSymbolicLink() || info.size > 131_072)
					throw new Error("Invalid requirements object");
				const text = await readFile(path, "utf8");
				if (objectiveDigest(text) !== hash) throw new Error("Requirement hash mismatch");
				return text;
			} catch {
				throw new ObjectiveError(
					"PRECONDITION_FAILED",
					"Pinned objective requirements are unavailable or changed; no completion or admission is justified.",
				);
			}
		},
		create: async (workspaceId, input) =>
			await change(workspaceId, input.requestId, objectiveDigest(JSON.stringify(input)), async (state) => {
				if (
					input.limits.mode === "enforce" &&
					(!options.admissionScopeAvailable || !input.acknowledgeAdmissionScope)
				)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						"Opt-in enforcement requires supported Kanban-admission coverage and explicit boundary acknowledgement; no guaranteed spending cap.",
					);
				if (state.objectives.length >= 1000)
					throw new ObjectiveError("PRECONDITION_FAILED", "Objective retention ceiling reached.");
				if (new Set(input.taskIds).size !== input.taskIds.length)
					throw new ObjectiveError("BAD_REQUEST", "Attach each task exactly once.");
				if (
					state.objectives.some((objective) => objective.tasks.some((task) => input.taskIds.includes(task.taskId)))
				)
					throw new ObjectiveError(
						"CONFLICT",
						"A task already belongs to an objective; membership is explicit, never guessed or double-charged.",
					);
				const at = now().toISOString();
				const requirementsHash = objectiveDigest(input.requirements);
				const path = paths(workspaceId);
				await mkdir(path.requirements, { recursive: true, mode: 0o700 });
				if ((await lstat(path.requirements)).isSymbolicLink())
					throw new ObjectiveError("PRECONDITION_FAILED", "Requirement storage cannot be a symlink.");
				const requirementPath = join(path.requirements, `${requirementsHash}.md`);
				try {
					const info = await lstat(requirementPath);
					if (
						!info.isFile() ||
						info.isSymbolicLink() ||
						info.size > 131_072 ||
						(await readFile(requirementPath, "utf8")) !== input.requirements
					)
						throw new ObjectiveError("PRECONDITION_FAILED", "An immutable requirement object is damaged.");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					const temporary = join(path.requirements, `${randomUUID()}.tmp`);
					await writeFileSynced(temporary, input.requirements, { mode: 0o600, flag: "wx" });
					await renameDurably(temporary, requirementPath);
				}
				const objective = objectiveSchema.parse({
					id: `obj-${randomUUID()}`,
					title: input.title,
					createdAt: at,
					updatedAt: at,
					revision: 1,
					requirementsHash,
					policy: input.policy,
					limits: input.limits,
					tasks: input.taskIds.map((taskId) => ({ taskId, kind: "dev", parentTaskId: null, attachedAt: at })),
					attempts: [],
					status: "awaiting_evidence",
					handoff: {
						code: "evidence_missing",
						owner: "supervision",
						action: "wait_for_evidence",
						taskId: null,
						since: at,
					},
					estimatedUsd: null,
					costCoverage: "unknown",
					finalCommits: [],
				});
				state.objectives.push(objective);
				return objective;
			}),
		setLimits: async (workspaceId, input) =>
			await change(workspaceId, input.requestId, objectiveDigest(JSON.stringify(input)), async (state) => {
				const objective = state.objectives.find((item) => item.id === input.id);
				if (!objective) throw new ObjectiveError("NOT_FOUND", "Objective not found.");
				if (objective.revision !== input.expectedRevision)
					throw new ObjectiveError(
						"CONFLICT",
						"Objective changed; read its latest revision before changing user-owned limits.",
					);
				if (
					input.limits.mode === "enforce" &&
					(!options.admissionScopeAvailable || !input.acknowledgeAdmissionScope)
				)
					throw new ObjectiveError(
						"PRECONDITION_FAILED",
						"Opt-in enforcement requires supported Kanban-admission coverage and explicit boundary acknowledgement; no guaranteed spending cap.",
					);
				objective.limits = input.limits;
				objective.revision += 1;
				objective.updatedAt = now().toISOString();
				return objective;
			}),
	};
	return store;
}
