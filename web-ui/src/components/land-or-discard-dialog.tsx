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
 * Asked when the runtime refuses Done on a card with work not on its base: "land or discard?" where Kanban lands the
 * card (landing mode qa), else "commit it first, or discard?" (`canLand` false: Done would only delete the worktree).
 * No choice is the default: the dialog opens with Cancel focused, so Enter or Escape leaves the card where it was.
 */
export function LandOrDiscardDialog({
	open,
	taskTitle,
	baseRef,
	canLand,
	onChoose,
}: {
	open: boolean;
	taskTitle: string;
	baseRef: string;
	canLand: boolean;
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
						<Button variant="primary" onClick={() => onChoose("land")}>
							Land on {baseRef}
						</Button>
					</AlertDialogAction>
				) : null}
			</AlertDialogFooter>
		</AlertDialog>
	);
}
