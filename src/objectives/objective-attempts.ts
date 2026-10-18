import type { RuntimeObjective } from "../core/objective-contract";
import { objectiveDigest } from "./objective-identity";

/** Server-owned session facts, not model assertions or replay instructions. */
export interface ObjectiveSessionObservation {
	taskId: string;
	startedAt: number | null;
	stateChangedAt: number | null;
	updatedAt: number;
	state: string;
	live: boolean;
	settled: boolean;
	/** Explicit false from the dispatcher means an empty composer/restore, not an admitted model turn. */
	submitted?: boolean;
	submittedAt?: number | null;
	executionBlocked?: boolean;
}

export function observeObjectiveAttempts(
	objective: RuntimeObjective,
	sessions: readonly ObjectiveSessionObservation[],
	complete = true,
): void {
	const members = new Set(objective.tasks.map((task) => task.taskId));
	const attachedAt = new Map(objective.tasks.map((task) => [task.taskId, Date.parse(task.attachedAt)]));
	for (const attempt of objective.attempts.filter((attempt) => attempt.state === "running")) {
		const session = sessions.find((session) => session.taskId === attempt.taskId);
		if (!session) {
			if (complete) {
				attempt.state = "unknown";
				attempt.endedAt = attempt.lastObservedAt ?? attempt.startedAt;
			}
			continue;
		}
		if (session.updatedAt < Date.parse(attempt.lastObservedAt ?? attempt.startedAt)) continue;
		const changedRun =
			session.startedAt !== null && attempt.runStartedAt !== new Date(session.startedAt).toISOString();
		if (session.executionBlocked) {
			attempt.state = "interrupted";
			attempt.endedAt = new Date(
				Math.max(Date.parse(attempt.startedAt), session.stateChangedAt ?? session.updatedAt),
			).toISOString();
			attempt.executionBlocked = true;
		} else if (!session.live || changedRun || session.state === "interrupted") {
			attempt.state = "interrupted";
			// Downtime / this server's hydration time is never counted as work or proof of completion.
			attempt.endedAt = attempt.lastObservedAt ?? attempt.startedAt;
		} else if (
			session.state === "running" &&
			Math.max(session.startedAt ?? 0, session.stateChangedAt ?? 0) > Date.parse(attempt.startedAt)
		) {
			attempt.state = "unknown";
			attempt.endedAt = attempt.lastObservedAt ?? attempt.startedAt;
		} else if (session.state !== "running" && session.settled) {
			attempt.state = "settled";
			attempt.endedAt = new Date(
				Math.max(Date.parse(attempt.startedAt), session.stateChangedAt ?? session.updatedAt),
			).toISOString();
		} else if (session.state === "running") attempt.lastObservedAt = new Date(session.updatedAt).toISOString();
	}
	for (const session of sessions) {
		if (
			!members.has(session.taskId) ||
			!session.live ||
			session.state !== "running" ||
			session.startedAt === null ||
			session.submitted === false
		)
			continue;
		if (
			objective.attempts.some(
				(attempt) =>
					attempt.taskId === session.taskId &&
					Date.parse(attempt.lastObservedAt ?? attempt.startedAt) > session.updatedAt,
			)
		)
			continue;
		const startedAt = Math.max(
			session.startedAt,
			session.stateChangedAt ?? session.startedAt,
			session.submittedAt ?? 0,
		);
		// A requirement created during an existing turn does not bind that turn retroactively.
		if (startedAt < Math.max(Date.parse(objective.createdAt), attachedAt.get(session.taskId) ?? 0)) continue;
		const start = new Date(startedAt).toISOString();
		const runStartedAt = new Date(session.startedAt).toISOString();
		const id = objectiveDigest(
			JSON.stringify([objective.id, objective.requirementsHash, session.taskId, runStartedAt, start]),
		);
		if (objective.attempts.some((attempt) => attempt.id === id)) continue;
		if (objective.attempts.length >= 2000) throw new Error("Objective attempt ceiling reached; history retained.");
		for (const previous of objective.attempts.filter(
			(attempt) => attempt.taskId === session.taskId && attempt.state === "running",
		)) {
			previous.state = "unknown";
			previous.endedAt = previous.lastObservedAt ?? previous.startedAt;
		}
		objective.attempts.push({
			id,
			taskId: session.taskId,
			startedAt: start,
			runStartedAt,
			lastObservedAt: new Date(session.updatedAt).toISOString(),
			endedAt: null,
			requirementsHash: objective.requirementsHash,
			snapshot: null,
			state: "running",
		});
	}
}
