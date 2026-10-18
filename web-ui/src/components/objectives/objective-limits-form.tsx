import { type ObjectiveLimitsChange, objectiveLimitsRequestSchema, type RuntimeObjective } from "@runtime-objectives";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { receiptRequestId } from "@/utils/receipt-request-id";

const inputClass = "w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-text-primary";
function initial(objective: RuntimeObjective) {
	return {
		revision: objective.revision,
		attempts: objective.limits.maxAttempts?.toString() ?? "",
		minutes: objective.limits.maxElapsedMinutes?.toString() ?? "",
		usd: objective.limits.maxEstimatedUsd?.toString() ?? "",
		mode: objective.limits.mode,
		unknownCost: objective.limits.unknownCost,
	};
}
export function ObjectiveLimitsForm({
	objective,
	available,
	busy,
	onSave,
}: {
	objective: RuntimeObjective;
	available: boolean;
	busy: boolean;
	onSave: (input: ObjectiveLimitsChange) => Promise<boolean>;
}) {
	const [draft, setDraft] = useState(() => initial(objective)),
		[dirty, setDirty] = useState(false),
		[acknowledge, setAcknowledge] = useState(false),
		[error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!dirty) {
			setDraft(initial(objective));
			setAcknowledge(false);
		}
	}, [objective, dirty]);
	const threshold = (text: string) => (text.trim() === "" ? null : Number(text));
	return (
		<details className="rounded-md border border-border p-3">
			<summary className="cursor-pointer text-sm font-semibold">User-owned admission limits</summary>
			<form
				className="mt-3 flex flex-col gap-2 text-xs"
				onSubmit={async (event) => {
					event.preventDefault();
					let requestId: string;
					try {
						requestId = receiptRequestId();
					} catch {
						setError("This browser cannot create safe receipt identities; no objective change was sent.");
						return;
					}
					const parsed = objectiveLimitsRequestSchema.safeParse({
						requestId,
						id: objective.id,
						expectedRevision: draft.revision,
						acknowledgeAdmissionScope: acknowledge,
						limits: {
							mode: draft.mode,
							maxAttempts: threshold(draft.attempts),
							maxElapsedMinutes: threshold(draft.minutes),
							maxEstimatedUsd: threshold(draft.usd),
							unknownCost: draft.unknownCost,
						},
					});
					if (!parsed.success || (draft.mode === "enforce" && !acknowledge)) {
						setError(
							"Enter valid nonnegative thresholds and explicitly acknowledge the scope before opting into enforcement.",
						);
						return;
					}
					setError(null);
					if (await onSave(parsed.data)) setDirty(false);
				}}
			>
				<p className="text-text-secondary">
					Report mode is the default. Enforcement gates new Kanban-issued sessions and prompts, not active tools,
					direct user keystrokes or internal CLI model calls. Estimated spend is never a guaranteed cap. Empty
					thresholds clear them.
				</p>
				<p className="text-text-tertiary">
					Draft revision {draft.revision}
					{dirty && draft.revision !== objective.revision
						? " is stale; preserve the draft and inspect the latest revision before changing limits."
						: ""}
				</p>
				{dirty && draft.revision !== objective.revision ? (
					<Button disabled={busy} onClick={() => setDraft({ ...draft, revision: objective.revision })}>
						Keep draft values and explicitly rebase to revision {objective.revision}
					</Button>
				) : null}
				<label>
					Admission mode
					<select
						className={inputClass}
						value={draft.mode}
						disabled={busy}
						onChange={(event) => {
							setDirty(true);
							setDraft({ ...draft, mode: event.target.value === "enforce" ? "enforce" : "report" });
						}}
					>
						<option value="report">Report only</option>
						<option value="enforce" disabled={!available}>
							Enforce Kanban admission (explicit opt-in)
						</option>
					</select>
				</label>
				{(["attempts", "minutes", "usd"] as const).map((field) => (
					<label key={field}>
						{field === "attempts"
							? "Attempt threshold"
							: field === "minutes"
								? "Elapsed minutes threshold"
								: "Observed estimated USD threshold"}
						<input
							className={inputClass}
							type="number"
							min={0}
							step={field === "attempts" ? 1 : "any"}
							value={draft[field]}
							disabled={busy}
							onChange={(event) => {
								setDirty(true);
								setDraft({ ...draft, [field]: event.target.value });
							}}
						/>
					</label>
				))}
				<label>
					Unknown-cost admission policy
					<select
						className={inputClass}
						value={draft.unknownCost}
						disabled={busy}
						onChange={(event) => {
							setDirty(true);
							setDraft({ ...draft, unknownCost: event.target.value === "allow" ? "allow" : "hold" });
						}}
					>
						<option value="hold">Hold new admission when a cost threshold has incomplete coverage</option>
						<option value="allow">Explicitly allow unknown cost (not a spending guarantee)</option>
					</select>
				</label>
				{draft.mode === "enforce" ? (
					<label className="flex items-start gap-2">
						<input
							type="checkbox"
							checked={acknowledge}
							disabled={busy}
							onChange={(event) => setAcknowledge(event.target.checked)}
						/>
						I acknowledge the Kanban-admission boundary and incomplete cost coverage; this does not approve any
						plan, model change, experiment or benchmark rerun.
					</label>
				) : null}
				{error ? (
					<p role="alert" className="text-status-red">
						{error}
					</p>
				) : null}
				<Button disabled={busy || (!available && draft.mode === "enforce")} type="submit">
					Save admission limits
				</Button>
			</form>
		</details>
	);
}
