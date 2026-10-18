import type { ObjectiveReadResponse } from "@runtime-objectives";
import { formatLocalTime } from "@/utils/format-local-time";

const money = (value: number | null) =>
	value === null
		? "Unknown"
		: value > 0 && value < 0.000001
			? "< $0.000001 (estimate)"
			: new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(
					value,
				);
/** Server decisions are rendered, never inferred from board columns, an agent claim, or token totals. */
export function ObjectiveReadout({ data }: { data: ObjectiveReadResponse }): React.ReactElement {
	const objective = data.objective;
	return (
		<section className="flex min-w-0 flex-col gap-3 text-[13px] text-text-primary" aria-label="Objective evidence">
			<div>
				<h3 className="break-words text-sm font-semibold">{objective.title}</h3>
				<p className="text-text-secondary">
					Runtime status: <strong>{objective.status.replaceAll("_", " ")}</strong> · Revision {objective.revision}
				</p>
				<p className="text-xs text-text-tertiary">Updated {formatLocalTime(Date.parse(objective.updatedAt))}</p>
			</div>
			<div className="rounded-md border border-status-orange/40 bg-status-orange/5 p-3">
				<strong>
					{objective.pausedByUser
						? "Kanban admission paused by user"
						: data.admissionScopeAvailable
							? objective.limits.mode === "enforce"
								? "Opt-in Kanban admission enforcement"
								: "Report mode — Kanban admission controls available"
							: "Report only — enforcement unavailable"}
				</strong>
				<p className="mt-1 text-text-secondary">
					Report thresholds do not block work. Opt-in enforcement gates new Kanban-issued sessions/prompts only,
					never active tools, direct user keystrokes, internal CLI model calls or a guaranteed spending cap.
					Recheck collects retained facts only.
				</p>
			</div>
			<dl className="grid grid-cols-2 gap-x-3 gap-y-1">
				<dt className="text-text-secondary">Total estimated cost</dt>
				<dd>{money(objective.estimatedUsd)}</dd>
				<dt className="text-text-secondary">Observed conservative subtotal</dt>
				<dd>{money(objective.observedEstimatedUsd)}</dd>
				<dt className="text-text-secondary">Cost coverage</dt>
				<dd>{objective.costCoverage} (not total spend)</dd>
				<dt className="text-text-secondary">Retained attempts / reservations</dt>
				<dd>
					{objective.attempts.length} / {objective.reservations.length}
				</dd>
				<dt className="text-text-secondary">Uncertain admissions</dt>
				<dd>
					{objective.reservations.filter((row) => row.state === "uncertain" || row.state === "reserved").length}
				</dd>
				<dt className="text-text-secondary">Reporting thresholds</dt>
				<dd>
					{objective.limits.maxAttempts === null
						? "No attempt threshold"
						: `${objective.limits.maxAttempts} attempts`}{" "}
					·{" "}
					{objective.limits.maxElapsedMinutes === null
						? "No time threshold"
						: `${objective.limits.maxElapsedMinutes} minutes`}{" "}
					·{" "}
					{objective.limits.maxEstimatedUsd === null
						? "No USD threshold"
						: money(objective.limits.maxEstimatedUsd)}
				</dd>
			</dl>
			<p className="text-text-secondary">
				Acceptance policy: checks {objective.policy.requiredChecks.join(", ")} · QA{" "}
				{objective.policy.requireQa ? "required" : "not required"} · authoritative landing required. Missing
				usage/pricing is never zero.
			</p>
			{objective.handoff ? (
				<div className="rounded-md border border-border bg-surface-2 p-3" role="status">
					<strong>
						{objective.handoff.code.replaceAll("_", " ")} · Owner: {objective.handoff.owner}
					</strong>
					<p className="mt-1 text-text-secondary">
						{data.handoffGuide?.summary ??
							"Inspect this project's existing owner evidence before approving any further work."}
					</p>
					{objective.handoff.taskId ? (
						<p className="mt-1 font-mono text-xs">Task {objective.handoff.taskId}</p>
					) : null}
				</div>
			) : null}
			<details open>
				<summary className="cursor-pointer text-text-secondary">Pinned requirements</summary>
				<p className="my-2 break-all font-mono text-xs">SHA-256 {objective.requirementsHash}</p>
				<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-0 p-3 font-sans">
					{data.requirements}
				</pre>
			</details>
			<details>
				<summary className="cursor-pointer text-text-secondary">Task lineage ({objective.tasks.length})</summary>
				<details>
					<summary className="cursor-pointer text-text-secondary">
						Current Kanban admission decisions / user control history
					</summary>
					<ul className="mt-2 space-y-1 text-xs">
						{data.admissionStates.map((row) => (
							<li key={`${row.taskId}:${row.kind}`}>
								{row.taskId} · {row.kind} ·{" "}
								{row.allowed
									? "eligible for ordinary guarded admission (not execution approval)"
									: `held: ${row.reason}`}
							</li>
						))}
					</ul>
					<ul className="mt-2 space-y-1 text-xs">
						{objective.controls.slice(-50).map((control) => (
							<li key={control.id}>
								{control.action} · {formatLocalTime(Date.parse(control.at))} · {control.reason}
								{control.taskId ? ` · ${control.taskId} ${control.kind}` : ""}
								{control.reservationId ? ` · reservation ${control.reservationId}` : ""}
								{control.usedBy ? ` · consumed by ${control.usedBy}` : ""}
								{control.revokedBy ? ` · revoked by ${control.revokedBy}` : ""}
							</li>
						))}
					</ul>
				</details>
				<ul className="mt-2 space-y-1">
					{objective.tasks.map((task) => (
						<li key={task.taskId} className="break-words font-mono text-xs">
							{task.taskId} · {task.kind}
							{task.parentTaskId ? ` ← ${task.parentTaskId}` : " · explicit root"}
						</li>
					))}
				</ul>
			</details>
			<details>
				<summary className="cursor-pointer text-text-secondary">
					Owner receipts ({objective.evidence.length})
				</summary>
				<ul className="mt-2 space-y-1">
					{objective.evidence.slice(-50).map((receipt) => (
						<li key={receipt.id} className="break-all font-mono text-xs">
							{receipt.kind} · {receipt.taskId} · snapshot {receipt.snapshot}
							{receipt.kind === "qa"
								? ` · ${receipt.verdict}`
								: receipt.kind === "landed"
									? ` · commit ${receipt.commit}`
									: ` · ${receipt.scripts.map((script) => `${script.name}: ${script.status}${script.harness ? " (harness)" : ""}`).join(", ")}`}
						</li>
					))}
				</ul>
				{objective.evidence.length > 50 ? (
					<p className="text-xs text-text-tertiary">
						Latest 50 shown. All receipts remain available through objective read.
					</p>
				) : null}
			</details>
			<details>
				<summary className="cursor-pointer text-text-secondary">
					Attempts ({objective.attempts.length}) / admissions ({objective.reservations.length})
				</summary>
				<ul className="mt-2 space-y-1 text-xs">
					{objective.attempts.slice(-50).map((attempt) => (
						<li key={attempt.id}>
							{attempt.taskId} · {attempt.state}
							{attempt.executionBlocked ? " · execution blocked" : ""} ·{" "}
							{formatLocalTime(Date.parse(attempt.startedAt))}
						</li>
					))}
				</ul>
				<ul className="mt-2 space-y-1 text-xs">
					{objective.reservations.slice(-50).map((reservation) => (
						<li key={reservation.id}>
							{reservation.taskId} · {reservation.kind} · {reservation.state} ·{" "}
							{formatLocalTime(Date.parse(reservation.at))}
							{reservation.report.length ? ` · reported: ${reservation.report.join(", ")}` : ""}
						</li>
					))}
				</ul>
				<p className="mt-1 text-xs text-text-tertiary">
					Latest 50 of each shown. Reservations are reporting records, not complete execution coverage or
					authorization to retry.
				</p>
			</details>
			<details>
				<summary className="cursor-pointer text-text-secondary">
					Usage / price revisions ({objective.usage.length})
				</summary>
				<ul className="mt-2 space-y-2 text-xs">
					{objective.usage.slice(-50).map((record) => (
						<li key={`${record.id}:${record.version}`} className="break-words">
							{record.taskId} · {record.observation.agent} · {record.observation.provider ?? "Unknown provider"}{" "}
							· {record.observation.model ?? "Unknown model"} ·{" "}
							{record.price
								? `${money(record.price.estimatedUsd)} ${record.price.kind.replaceAll("_", " ")}`
								: "Unknown price"}
							<p className="text-text-secondary">
								{record.uncertainty.length
									? record.uncertainty.join(", ")
									: "Observed request attribution only; total coverage not established"}
							</p>
							{record.price ? (
								<p className="break-all font-mono text-[11px]">
									Price {record.price.source} SHA-256 {record.price.revision}
								</p>
							) : null}
						</li>
					))}
				</ul>
				<p className="mt-1 text-xs text-text-tertiary">
					Latest 50 retained revisions shown, not additional charges. Source rereads are not summed as new spend.
				</p>
			</details>
			{objective.finalCommits.length ? (
				<div>
					<strong>Verified final commits</strong>
					<ul>
						{objective.finalCommits.map((commit) => (
							<li key={commit} className="break-all font-mono text-xs">
								{commit}
							</li>
						))}
					</ul>
				</div>
			) : (
				<p className="text-text-secondary">
					No qualified final commit recorded. A final reply or Done column is not acceptance.
				</p>
			)}
		</section>
	);
}
