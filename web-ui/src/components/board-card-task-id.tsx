import type { MouseEvent } from "react";
import { showAppToast } from "@/components/app-toaster";
import { Tooltip } from "@/components/ui/tooltip";

async function copyTaskId(taskId: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(taskId);
		showAppToast({ intent: "success", message: `Copied ${taskId}`, timeout: 2000 }, `copy-task-id-${taskId}`);
	} catch {
		showAppToast({ intent: "warning", message: `Could not copy ${taskId} to the clipboard.` });
	}
}

export function BoardCardTaskId({ taskId }: { taskId: string }): React.ReactElement {
	// The card opens on click and drags on mouse down, so the id button swallows both.
	const stopEvent = (event: MouseEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<Tooltip content="Copy task id">
			<button
				type="button"
				data-testid="board-card-task-id"
				aria-label={`Copy task id ${taskId}`}
				className="inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-md border border-border bg-surface-1 px-1.5 py-0.5 font-mono text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
				onMouseDown={stopEvent}
				onClick={(event) => {
					stopEvent(event);
					void copyTaskId(taskId);
				}}
			>
				{taskId}
			</button>
		</Tooltip>
	);
}
