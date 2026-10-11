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
import type { RuntimePipelineCardStage } from "@/runtime/types";

/**
 * Asked before Approve & land while the pipeline still checks or QAs the card (issue #30: foo's 8c28e was landed by
 * hand while its checks ran, because the card looked idle). It warns, it doesn't block: Land anyway lands as before.
 * Cancel is focused, so Enter or Escape leaves the card to the pipeline.
 */
export function ApproveAndLandWarningDialog({
	open,
	taskTitle,
	stage,
	onResolve,
}: {
	open: boolean;
	taskTitle: string;
	stage: RuntimePipelineCardStage | null;
	onResolve: (land: boolean) => void;
}): ReactElement {
	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onResolve(false);
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Land before the pipeline is done?</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					The pipeline is still working on <span className="text-text-primary">{taskTitle}</span>:
				</AlertDialogDescription>
				{stage ? <PipelineInFlightNotice stage={stage} action="Approve & land" /> : null}
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={() => onResolve(false)}>
						Wait for the pipeline
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="danger" onClick={() => onResolve(true)}>
						Land anyway
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
