import { BookOpen } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "@/components/ui/dialog";
import { useTaskPlanContext } from "@/hooks/use-task-plan-context";
import { TaskReferenceAdoption } from "./task-reference-adoption";

/** Reads metadata only on opening; document bodies remain explicit bounded, exact-context reads. */
export function TaskPlanContextButton({
	taskId,
	workspaceId,
	onOpenChange,
}: {
	taskId: string;
	workspaceId: string | null;
	onOpenChange?: (open: boolean) => void;
}) {
	const [open, setOpen] = useState(false);
	const { query, read, selected, select, reset } = useTaskPlanContext(workspaceId, taskId, open);
	const close = (value: boolean) => {
		setOpen(value);
		onOpenChange?.(value);
		if (!value) reset();
	};
	const context = query.data?.context;
	const onAdopted = useCallback(() => {
		reset();
		void query.refetch();
	}, [reset, query.refetch]);
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				icon={<BookOpen size={14} />}
				disabled={!workspaceId}
				onClick={() => close(true)}
			>
				Plan context
			</Button>
			<Dialog open={open} onOpenChange={close}>
				<DialogHeader title={`Plan context · ${taskId}`} />
				<DialogBody>
					<div className="space-y-3 text-sm">
						{query.isLoading ? (
							<p>Loading retained pointers…</p>
						) : query.error ? (
							<p role="alert" className="text-status-red">
								{query.error.message}
							</p>
						) : !context ? (
							<p className="text-text-secondary">This task has no approved-plan knowledge handoff.</p>
						) : (
							<>
								<p className="break-all text-xs text-text-secondary">
									Context {context.revision}
									<br />
									Reviewed bundle {context.bundleRevision}
								</p>
								<p className="text-text-secondary">
									Pinned reference context, not a new approval. Shared revisions never replace these pins
									automatically.
								</p>
								{query.data?.drift.map((item) => (
									<p key={item.id} className="break-all text-xs text-status-orange">
										Revision drift: {item.id} · pinned {item.pinned.slice(0, 12)} · current{" "}
										{item.current?.slice(0, 12) ?? "missing"}. Not automatically adopted.
									</p>
								))}
								<div className="flex flex-wrap gap-2">
									<Button size="sm" onClick={() => select({ part: "spec", offset: 0 })}>
										Read retained spec
									</Button>
									<Button size="sm" onClick={() => select({ part: "breakdown", offset: 0 })}>
										Read exact breakdown
									</Button>
								</div>
								<ul className="space-y-2">
									{context.documents.map((document) => (
										<li key={document.id} className="break-all text-xs">
											{document.title} · {document.id} · {document.revision.slice(0, 12)}
											{document.pinnedByUser ? " · user pin" : ""}
											<Button
												size="sm"
												variant="ghost"
												onClick={() => select({ part: "document", id: document.id, offset: 0 })}
											>
												Read {document.id}
											</Button>
										</li>
									))}
								</ul>
								{query.data ? (
									<TaskReferenceAdoption
										key={context.revision}
										taskId={taskId}
										workspaceId={workspaceId}
										view={query.data}
										onAdopted={onAdopted}
									/>
								) : null}
								{query.data?.startReservation ? (
									<p className="text-xs text-status-orange">
										Physical start reserved: reference context is frozen, including blank or uncertain
										launches.
									</p>
								) : null}
								{query.data?.history
									.filter((item) => item.adoption)
									.map((item) => (
										<div key={item.revision} className="space-y-1 text-xs text-text-secondary">
											<p className="break-all">
												User adoption {item.revision}: {item.adoption?.documentId} · {item.adoption?.reason}
												. Original plan approval unchanged.
											</p>
											<Button
												size="sm"
												variant="ghost"
												onClick={() =>
													select({
														part: "document",
														id: item.adoption?.documentId,
														offset: 0,
														contextRevision: item.adoption?.parentRevision,
													})
												}
											>
												Read previous reference
											</Button>
										</div>
									))}
								{selected ? (
									read.isLoading ? (
										<p>Loading pinned content…</p>
									) : read.error ? (
										<p role="alert" className="text-status-red">
											{read.error.message}
										</p>
									) : read.data ? (
										<>
											<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-0 p-3 text-xs">
												{read.data.markdown}
											</pre>
											{read.data.nextOffset !== null ? (
												<Button
													size="sm"
													onClick={() => select({ ...selected, offset: read.data?.nextOffset ?? 0 })}
												>
													Read next slice
												</Button>
											) : null}
										</>
									) : null
								) : null}
							</>
						)}
					</div>
				</DialogBody>
			</Dialog>
		</>
	);
}
