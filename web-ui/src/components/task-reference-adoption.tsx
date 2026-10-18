import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { useTaskPlanContext } from "@/hooks/use-task-plan-context";
import { useTaskReferenceAdoption } from "@/hooks/use-task-reference-adoption";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

type View = NonNullable<ReturnType<typeof useTaskPlanContext>["query"]["data"]>;
export function TaskReferenceAdoption({
	workspaceId,
	taskId,
	view,
	onAdopted,
}: {
	workspaceId: string | null;
	taskId: string;
	view: View;
	onAdopted: () => void;
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null),
		[reason, setReason] = useState(""),
		[offset, setOffset] = useState(0);
	const selected = view.drift.find((item) => item.id === selectedId);
	const queryFn = useCallback(async () => {
		if (!selected?.current) throw new Error("Select a published replacement revision first.");
		return getRuntimeTrpcClient(workspaceId).knowledge.read.query({
			id: selected.id,
			revision: selected.current,
			offset,
			limit: 4096,
		});
	}, [workspaceId, selected, offset]);
	const review = useTrpcQuery({ enabled: Boolean(selected?.current), queryFn });
	const mutation = useTaskReferenceAdoption(workspaceId);
	useEffect(() => {
		if (mutation.result.value) onAdopted();
	}, [mutation.result.value, onAdopted]);
	if (!view.context || !view.drift.length) return null;
	return (
		<section className="space-y-2 rounded-md border border-border p-3">
			<p className="text-xs text-text-secondary">
				Explicit user choice, before any physical start. Only this reference changes; the original approved spec,
				breakdown, acceptance criteria and verdicts stay unchanged. This never starts work or grants execution
				approval.
			</p>
			{!view.canAdopt ? (
				<p className="text-xs text-status-orange">
					Adoption unavailable: unstarted eligibility is not proven, a start was reserved, or physical-start
					serialization is unavailable.
				</p>
			) : (
				<>
					<div className="flex flex-wrap gap-2">
						{view.drift
							.filter((item) => item.current)
							.map((item) => (
								<Button
									size="sm"
									key={item.id}
									disabled={mutation.isSubmitting}
									onClick={() => {
										review.setData(null);
										setSelectedId(item.id);
										setOffset(0);
									}}
								>
									Review replacement {item.id}
								</Button>
							))}
					</div>
					{selected ? (
						<>
							<p className="break-all font-mono text-xs">
								{selected.id}: {selected.pinned} → {selected.current}
							</p>
							{review.isLoading ? (
								<p>Reading exact replacement…</p>
							) : review.error ? (
								<p role="alert" className="text-status-red">
									{review.error.message}
								</p>
							) : review.data ? (
								<>
									<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-0 p-2 text-xs">
										{review.data.markdown}
									</pre>
									{review.data.nextOffset !== null ? (
										<Button
											size="sm"
											onClick={() => {
												review.setData(null);
												setOffset(review.data?.nextOffset ?? 0);
											}}
										>
											Read next replacement slice
										</Button>
									) : null}
								</>
							) : null}
							<label className="block text-xs text-text-secondary">
								Reference adoption reason
								<input
									aria-label="Reference adoption reason"
									className="mt-1 w-full rounded-md border border-border-bright bg-surface-2 p-2 text-text-primary"
									value={reason}
									maxLength={1000}
									onChange={(event) => setReason(event.currentTarget.value)}
									disabled={mutation.isSubmitting}
								/>
							</label>
							<Button
								size="sm"
								variant="primary"
								disabled={
									mutation.isSubmitting ||
									!reason.trim() ||
									!review.data ||
									review.data.document.revision !== selected.current
								}
								onClick={() => {
									if (view.context && selected.current)
										mutation.submit({
											taskId,
											expectedContextRevision: view.context.revision,
											documentId: selected.id,
											expectedDocumentRevision: selected.pinned,
											targetRevision: selected.current,
											reason: reason.trim(),
										});
								}}
							>
								Adopt reviewed reference
							</Button>
						</>
					) : null}
					{mutation.result.error ? (
						<p role="alert" className="text-status-red">
							{mutation.result.error.message} An exact retry keeps its receipt; no automatic retry is performed.
						</p>
					) : null}
				</>
			)}
		</section>
	);
}
