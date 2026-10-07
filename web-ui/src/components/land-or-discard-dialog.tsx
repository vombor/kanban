import type { ReactElement } from "react";

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

/**
 * Asked when Done on a landing-mode-qa card with work not on its base is refused by the runtime. Neither choice
 * is the default: the dialog opens with Cancel focused, so Enter or Escape leaves the card where it was.
 */
export function LandOrDiscardDialog({
	open,
	taskTitle,
	baseRef,
	onChoose,
}: {
	open: boolean;
	taskTitle: string;
	baseRef: string;
	onChoose: (choice: RuntimeTaskLandingChoice | null) => void;
}): ReactElement {
	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onChoose(null);
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Land or discard?</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					<span className="text-text-primary">{taskTitle}</span> has work that is not on{" "}
					<span className="font-mono">{baseRef}</span>.
				</AlertDialogDescription>
				<p className="text-text-secondary">
					Land squash-merges it onto {baseRef} before moving the task to Done. Discard moves it to Done without
					landing; the work is kept only as the task's saved patch.
				</p>
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
				<AlertDialogAction asChild>
					<Button variant="primary" onClick={() => onChoose("land")}>
						Land on {baseRef}
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
