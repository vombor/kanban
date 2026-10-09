import { CheckCircle2, ClipboardCheck } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { usePlanApproval } from "@/hooks/use-plan-approval";
import { useCurrentWorkspaceId } from "@/stores/current-workspace-store";

function stopEvent(event: { stopPropagation: () => void }): void {
	event.stopPropagation();
}

/**
 * Approve plan on a plan card in Review: the user's approval of its card breakdown, which lets the orchestrator expand
 * it (`kanban plan expand`). The dialog shows the spec's title, the card count and the breakdown's hash, and the
 * user confirms; the runtime records the approval of exactly that breakdown.
 */
export function PlanApprovalButton({ taskId, taskTitle }: { taskId: string; taskTitle: string }): ReactElement {
	const workspaceId = useCurrentWorkspaceId();
	const [open, setOpen] = useState(false);
	const approval = usePlanApproval(workspaceId, taskId, open);
	const { preview, step } = approval;

	const { reset } = approval;
	const close = () => {
		setOpen(false);
		reset();
	};

	const approvedCurrent = preview?.approval?.state === "approved";
	useEffect(() => {
		if (step.kind !== "approved") {
			return;
		}
		showAppToast({ intent: "success", message: "Plan approved: the orchestrator can expand it." }, `plan-${taskId}`);
		setOpen(false);
		reset();
	}, [reset, step.kind, taskId]);

	return (
		<>
			<Button
				variant="primary"
				size="sm"
				fill
				icon={<ClipboardCheck size={14} />}
				onMouseDown={stopEvent}
				onClick={(event) => {
					stopEvent(event);
					setOpen(true);
				}}
			>
				Approve plan
			</Button>
			{/* The dialog is portaled, but React still bubbles its events to the card: keep them off the card. */}
			<span className="contents" onClick={stopEvent} onMouseDown={stopEvent} onKeyDown={stopEvent}>
				<AlertDialog
					open={open}
					onOpenChange={(isOpen) => {
						if (!isOpen) close();
					}}
				>
					<AlertDialogHeader>
						<AlertDialogTitle>Approve plan?</AlertDialogTitle>
					</AlertDialogHeader>
					<AlertDialogBody>
						{approval.isLoadingPreview && !preview ? (
							<div className="flex items-center gap-2 text-text-secondary">
								<Spinner size={14} /> Reading the plan…
							</div>
						) : preview ? (
							<>
								<AlertDialogDescription>
									<span className="text-text-primary">{preview.specTitle || preview.title || taskTitle}</span>:{" "}
									{preview.cards} {preview.cards === 1 ? "card" : "cards"}, spec{" "}
									<span className="font-mono">{preview.specPath}</span>, breakdown{" "}
									<span className="font-mono">{preview.breakdownSha256.slice(0, 12)}</span>.
								</AlertDialogDescription>
								<p className="text-text-secondary">
									Approve only a plan you reviewed yourself: approving lets the orchestrator create these cards
									in Backlog. A later change to the breakdown needs a new approval.
								</p>
								{approvedCurrent ? (
									<p className="flex items-center gap-1.5 text-status-green">
										<CheckCircle2 size={14} /> Already approved for this breakdown.
									</p>
								) : null}
							</>
						) : null}
						{approval.error ? <p className="text-status-red">{approval.error}</p> : null}
					</AlertDialogBody>
					<AlertDialogFooter>
						<AlertDialogCancel asChild>
							<Button variant="default" onClick={close}>
								Cancel
							</Button>
						</AlertDialogCancel>
						<Button
							variant="primary"
							disabled={approval.isSubmitting || !preview || approvedCurrent}
							icon={approval.isSubmitting ? <Spinner size={12} /> : undefined}
							onClick={() => void approval.approve()}
						>
							Approve plan
						</Button>
					</AlertDialogFooter>
				</AlertDialog>
			</span>
		</>
	);
}
