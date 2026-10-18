import {
	type ObjectiveControlRequest,
	type ObjectiveManualLineage,
	objectiveControlRequestSchema,
	objectiveManualLineageSchema,
	type RuntimeObjective,
} from "@runtime-objectives";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { receiptRequestId } from "@/utils/receipt-request-id";

const inputClass = "w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-text-primary";
export function ObjectiveControls({
	objective,
	busy,
	onControl,
	onLink,
}: {
	objective: RuntimeObjective;
	busy: boolean;
	onControl: (input: ObjectiveControlRequest) => Promise<boolean>;
	onLink: (input: ObjectiveManualLineage) => Promise<boolean>;
}) {
	const [reason, setReason] = useState(""),
		[taskId, setTaskId] = useState(objective.tasks[0]?.taskId ?? ""),
		[kind, setKind] = useState<"start" | "input">("start"),
		[reservationId, setReservationId] = useState("");
	const [controlId, setControlId] = useState("");
	const [parent, setParent] = useState(objective.tasks.find((task) => task.kind !== "qa")?.taskId ?? ""),
		[child, setChild] = useState(""),
		[error, setError] = useState<string | null>(null);
	const act = async (action: ObjectiveControlRequest["action"]) => {
		let requestId: string;
		try {
			requestId = receiptRequestId();
		} catch {
			setError("This browser cannot create safe receipt identities; no objective change was sent.");
			return;
		}
		const parsed = objectiveControlRequestSchema.safeParse({
			id: objective.id,
			requestId,
			expectedRevision: objective.revision,
			action,
			reason,
			taskId: action === "override" ? taskId : null,
			kind: action === "override" ? kind : null,
			reservationId: action === "acknowledge" ? reservationId : null,
			controlId: action === "revoke" ? controlId : null,
		});
		if (!parsed.success) {
			setError("Enter an audit reason and the exact task/operation or uncertain reservation for this action.");
			return;
		}
		setError(null);
		if (await onControl(parsed.data)) setReason("");
	};
	const uncertain = objective.reservations.filter(
		(row) =>
			(row.state === "reserved" || row.state === "uncertain") &&
			!objective.controls.some((control) => control.action === "acknowledge" && control.reservationId === row.id),
	);
	return (
		<details className="rounded-md border border-border p-3">
			<summary className="cursor-pointer text-sm font-semibold">User-owned controls and explicit lineage</summary>
			<div className="mt-3 flex flex-col gap-2 text-xs">
				<p className="text-text-secondary">
					Pause blocks future Kanban admission only. Resume clears that pause; existing valid queued work may
					proceed, but no uncertain turn is replayed. Overrides permit one next matching admission without erasing
					counts, guards, acceptance requirements or benchmark approvals.
				</p>
				<label>
					Control audit reason
					<textarea
						className={inputClass}
						value={reason}
						maxLength={1000}
						disabled={busy}
						onChange={(event) => setReason(event.target.value)}
					/>
				</label>
				<Button
					disabled={busy || !reason.trim()}
					onClick={() => {
						void act(objective.pausedByUser ? "resume" : "pause");
					}}
				>
					{objective.pausedByUser ? "Resume Kanban admission" : "Pause Kanban admission"}
				</Button>
				<label>
					Override task
					<select
						className={inputClass}
						value={taskId}
						disabled={busy}
						onChange={(event) => setTaskId(event.target.value)}
					>
						{objective.tasks.map((task) => (
							<option key={task.taskId} value={task.taskId}>
								{task.taskId} · {task.kind}
							</option>
						))}
					</select>
				</label>
				<label>
					One next operation
					<select
						className={inputClass}
						value={kind}
						disabled={busy}
						onChange={(event) => setKind(event.target.value === "input" ? "input" : "start")}
					>
						<option value="start">New session start</option>
						<option value="input">Kanban prompt submission</option>
					</select>
				</label>
				<Button
					disabled={busy || !reason.trim()}
					onClick={() => {
						void act("override");
					}}
				>
					Grant one admission override
				</Button>
				<label>
					Unused override to revoke
					<select
						className={inputClass}
						value={controlId}
						disabled={busy}
						onChange={(event) => setControlId(event.target.value)}
					>
						<option value="">Select an unused own override</option>
						{objective.controls
							.filter((row) => row.action === "override" && row.usedBy === null && row.revokedBy === null)
							.map((row) => (
								<option key={row.id} value={row.id}>
									{row.taskId} · {row.kind} · {row.id}
								</option>
							))}
					</select>
				</label>
				<Button
					disabled={busy || !reason.trim() || !controlId}
					onClick={() => {
						void act("revoke");
					}}
				>
					Revoke unused override (retain audit history)
				</Button>
				<label>
					Uncertain admission
					<select
						className={inputClass}
						value={reservationId}
						disabled={busy}
						onChange={(event) => setReservationId(event.target.value)}
					>
						<option value="">Select a retained reservation</option>
						{uncertain.map((row) => (
							<option key={row.id} value={row.id}>
								{row.taskId} · {row.kind} · {row.id}
							</option>
						))}
					</select>
				</label>
				<Button
					disabled={busy || !reason.trim() || !reservationId}
					onClick={() => {
						void act("acknowledge");
					}}
				>
					Acknowledge uncertainty (retain charge/history)
				</Button>
				<p className="text-text-secondary">
					Acknowledgement is a user's review record, not proof of delivery, cost coverage, acceptance or permission
					to replay that reservation.
				</p>
				<label>
					Implementation parent
					<select
						className={inputClass}
						value={parent}
						disabled={busy}
						onChange={(event) => setParent(event.target.value)}
					>
						{objective.tasks
							.filter((task) => task.kind !== "qa")
							.map((task) => (
								<option key={task.taskId} value={task.taskId}>
									{task.taskId}
								</option>
							))}
					</select>
				</label>
				<label>
					Unstarted Backlog dev-task id
					<input
						className={inputClass}
						value={child}
						disabled={busy}
						onChange={(event) => setChild(event.target.value)}
					/>
				</label>
				<Button
					disabled={busy || !child.trim()}
					onClick={async () => {
						let requestId: string;
						try {
							requestId = receiptRequestId();
						} catch {
							setError("This browser cannot create safe receipt identities; no objective change was sent.");
							return;
						}
						const parsed = objectiveManualLineageSchema.safeParse({
							requestId,
							id: objective.id,
							expectedRevision: objective.revision,
							parentTaskId: parent,
							taskIds: [child.trim()],
							kind: "rework",
							planned: false,
						});
						if (!parsed.success) {
							setError("Choose an implementation parent and an unstarted own-project dev task.");
							return;
						}
						setError(null);
						if (await onLink(parsed.data)) setChild("");
					}}
				>
					Link replacement (no start or execution approval)
				</Button>
				{error ? (
					<p role="alert" className="text-status-red">
						{error}
					</p>
				) : null}
			</div>
		</details>
	);
}
