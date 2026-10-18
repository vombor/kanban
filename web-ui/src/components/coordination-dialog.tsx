import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useKnowledgeQuery } from "@/hooks/use-knowledge-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export function CoordinationDialog(props: { workspaceId: string; onClose: () => void }) {
	return <CoordinationScope key={props.workspaceId} {...props} />;
}
function CoordinationScope({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
	const [draft, setDraft] = useState(""),
		[planTaskId, setPlanTaskId] = useState<string | undefined>(),
		[generation, setGeneration] = useState(0);
	const load = useCallback(
		() => getRuntimeTrpcClient(workspaceId).coordination.preview.query({ planTaskId }),
		[workspaceId, planTaskId],
	);
	const result = useKnowledgeQuery(JSON.stringify([workspaceId, planTaskId, generation]), load);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			contentClassName="max-w-4xl"
		>
			<DialogHeader title="Coordination preview" />
			<DialogBody className="space-y-3">
				<p className="text-sm text-text-secondary">
					Advisory only. Prerequisites satisfied is not permission to start. No tasks, assignments, dependencies,
					approvals, QA verdicts or landing decisions are changed.
				</p>
				<form
					className="flex flex-wrap gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						setPlanTaskId(draft.trim() || undefined);
						setGeneration((n) => n + 1);
					}}
				>
					<input
						aria-label="Approved plan id (optional)"
						value={draft}
						maxLength={80}
						onChange={(event) => setDraft(event.currentTarget.value)}
						placeholder="Approved plan id, or empty for current board"
						className="min-w-0 flex-1 rounded-md border border-border-bright bg-surface-2 px-2"
					/>
					<Button size="sm" type="submit">
						Read coordination preview
					</Button>
				</form>
				{result.isError ? (
					<p role="alert" className="text-status-red">
						Coordination sources are unavailable or this plan has no matching approved full bundle. No mutable
						fallback or workflow action was used.
					</p>
				) : result.isLoading ? (
					<p>Reading native owners and retained snapshots…</p>
				) : result.data ? (
					<>
						<p className="text-xs text-text-secondary">
							{result.data.tasks.length} tasks · {result.data.dependencies.length} existing dependencies
							{result.data.truncated ? " · Bounded/truncated report" : ""}. Costs and completion times remain
							unknown. Unsubmitted work is not included.
						</p>
						<h3 className="text-sm font-semibold">Native task state</h3>
						<ul className="space-y-2 text-sm">
							{result.data.tasks.map((task) => (
								<li key={task.id} className="rounded-md border border-border p-2">
									<p className="break-words">
										{task.id} · {task.title}
									</p>
									<p>
										{task.state} · {task.readiness.replaceAll("_", " ")}
									</p>
									{task.state === "review" ? (
										<p>Native Review settle evidence: {task.reviewSettled ? "settled" : "not settled"}</p>
									) : null}
									{task.ownerStates.length ? <p>Owner state: {task.ownerStates.join(", ")}</p> : null}
									{task.prerequisites ? (
										<p>
											Prerequisites: {task.prerequisites.done}/{task.prerequisites.total} satisfied
											{task.prerequisites.missing.length
												? " · missing prerequisite; manual review needed"
												: ""}
										</p>
									) : null}
									{task.capacityHold ? (
										<p>
											Existing model-capacity hold · {task.otherProjectHolders} holder(s) in other projects
										</p>
									) : null}
									<p className="text-xs text-text-secondary">
										{task.observedPaths.length} retained snapshot paths
										{task.pathsTruncated ? " · incomplete or unavailable" : ""}; ownership hints are not
										locks.
									</p>
								</li>
							))}
						</ul>
						<h3 className="text-sm font-semibold">Possible sequencing considerations</h3>
						{result.data.advice.length ? (
							<ul className="space-y-2 text-sm">
								{result.data.advice.map((advice, index) => (
									<li key={`${index}:${advice.kind}`} className="break-words">
										<p>
											{advice.tasks.join(" ↔ ")} · {advice.kind.replaceAll("_", " ")}
										</p>
										<p className="text-xs text-text-secondary">
											{advice.details.join("; ")} ({advice.basis.replaceAll("_", " ")})
										</p>
									</li>
								))}
							</ul>
						) : (
							<p className="text-sm">
								No overlap found in the available bounded evidence. This is not a conflict-free or readiness
								guarantee.
							</p>
						)}
						<details>
							<summary className="cursor-pointer text-sm">Evidence boundaries</summary>
							<ul className="text-xs text-text-secondary">
								{result.data.warnings.map((warning) => (
									<li key={warning}>{warning.replaceAll("_", " ")}</li>
								))}
							</ul>
							<p className="break-all text-xs">Report fingerprint: {result.data.fingerprint}</p>
							{result.data.approvedBundle ? (
								<p className="break-all text-xs">Approved bundle: {result.data.approvedBundle}</p>
							) : null}
						</details>
					</>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button size="sm" onClick={() => setGeneration((n) => n + 1)}>
					Refresh coordination
				</Button>
				<Button size="sm" onClick={onClose}>
					Close coordination
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
