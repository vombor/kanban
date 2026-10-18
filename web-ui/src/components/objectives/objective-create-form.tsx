import { type ObjectiveCreate, objectiveCreateSchema } from "@runtime-objectives";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { receiptRequestId } from "@/utils/receipt-request-id";

const inputClass = "w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-text-primary";
export function ObjectiveCreateForm({
	busy,
	onCreate,
}: {
	busy: boolean;
	onCreate: (input: ObjectiveCreate) => Promise<boolean>;
}) {
	const [title, setTitle] = useState(""),
		[requirements, setRequirements] = useState(""),
		[tasks, setTasks] = useState("");
	const [checks, setChecks] = useState("test"),
		[qa, setQa] = useState(true),
		[error, setError] = useState<string | null>(null);
	return (
		<details className="rounded-md border border-border p-3">
			<summary className="cursor-pointer text-sm font-semibold">Create objective (no task start)</summary>
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
					const parsed = objectiveCreateSchema.safeParse({
						requestId,
						title,
						requirements,
						taskIds: tasks.split(/[\s,]+/u).filter(Boolean),
						policy: {
							requiredChecks: checks.split(/[\s,]+/u).filter(Boolean),
							requireQa: qa,
							completion: "landed",
						},
						limits: { mode: "report" },
					});
					if (!parsed.success) {
						setError("Enter a title, pinned requirements, existing dev-task ids and required check names.");
						return;
					}
					setError(null);
					if (await onCreate(parsed.data)) {
						setTitle("");
						setRequirements("");
						setTasks("");
					}
				}}
			>
				<p className="text-text-secondary">
					User-owned reference/acceptance criteria, never plan, runoff or benchmark execution approval. Existing
					unbound results are not adopted.
				</p>
				<label>
					Objective title
					<input
						className={inputClass}
						value={title}
						maxLength={160}
						onChange={(event) => setTitle(event.target.value)}
						disabled={busy}
					/>
				</label>
				<label>
					Pinned requirements
					<textarea
						className={inputClass}
						rows={5}
						value={requirements}
						maxLength={32768}
						onChange={(event) => setRequirements(event.target.value)}
						disabled={busy}
					/>
				</label>
				<label>
					Existing dev-task ids
					<input
						className={inputClass}
						value={tasks}
						onChange={(event) => setTasks(event.target.value)}
						disabled={busy}
					/>
				</label>
				<label>
					Required check scripts
					<input
						className={inputClass}
						value={checks}
						onChange={(event) => setChecks(event.target.value)}
						disabled={busy}
					/>
				</label>
				<label className="flex items-center gap-2">
					<input type="checkbox" checked={qa} onChange={(event) => setQa(event.target.checked)} disabled={busy} />
					Require exact-snapshot QA
				</label>
				{error ? (
					<p role="alert" className="text-status-red">
						{error}
					</p>
				) : null}
				<Button disabled={busy} type="submit">
					Pin objective requirements
				</Button>
			</form>
		</details>
	);
}
