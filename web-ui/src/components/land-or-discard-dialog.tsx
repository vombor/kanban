import type { ReactElement } from "react";

import { PipelineInFlightNotice } from "@/components/pipeline-in-flight-notice";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import type { RuntimeTaskLandingChoice } from "@/runtime/types";
import { useInFlightPipelineCardStage } from "@/stores/pipeline-card-stage-store";

/**
 * Asked when the runtime refuses Done on a card with work not on its base: "land or discard?" where Kanban lands the
 * card (landing mode qa), else "commit it first, or discard?" (`canLand` false: Done would only delete the worktree).
 * No choice is the default: the dialog opens with Cancel focused, so Enter or Escape leaves the card where it was.
 * While the pipeline still checks or QAs the card (issue #30), it shows the stage as Approve & land's warning does and
 * Land becomes "Land anyway"; Discard is unchanged, since it lands nothing.
 */
export function LandOrDiscardDialog({
	open,
	taskId,
	taskTitle,
	baseRef,
	canLand,
	onChoose,
}: {
	open: boolean;
	taskId: string | null;
	taskTitle: string;
	baseRef: string;
	canLand: boolean;
	onChoose: (choice: RuntimeTaskLandingChoice | null) => void;
}): ReactElement {
	const inFlightStage = useInFlightPipelineCardStage(open && canLand ? taskId : null);
	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onChoose(null);
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>{canLand ? "Land or discard?" : "Discard uncommitted work?"}</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					<span className="text-text-primary">{taskTitle}</span> has work that is not{" "}
					{canLand ? "on" : "committed to"} <span className="font-mono">{baseRef}</span>.
				</AlertDialogDescription>
				{canLand ? (
					<p className="text-text-secondary">
						Land squash-merges it onto {baseRef} before moving the task to Done. Discard moves it to Done without
						landing; the work is kept only as the task's saved patch.
					</p>
				) : (
					<p className="text-text-secondary">
						Moving the task to Done deletes its worktree. To keep the work, cancel and use Commit or Open PR
						first. Discard moves it to Done anyway; the work is kept only as the task's saved patch.
					</p>
				)}
				{inFlightStage ? (
					<div className="flex flex-col gap-1 rounded-md border border-status-orange/30 bg-status-orange/10 p-2">
						<p className="text-status-orange">The pipeline is still working on it:</p>
						<PipelineInFlightNotice stage={inFlightStage} action="Land" />
					</div>
				) : null}
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={() => onChoose(null)}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="danger" onClick={() => onChoose("discard")}>
						Discard
					</Button>
				</AlertDialogAction>
				{canLand ? (
					<AlertDialogAction asChild>
						<Button variant={inFlightStage ? "danger" : "primary"} onClick={() => onChoose("land")}>
							{inFlightStage ? `Land anyway on ${baseRef}` : `Land on ${baseRef}`}
						</Button>
					</AlertDialogAction>
				) : null}
			</AlertDialogFooter>
		</AlertDialog>
	);
}
