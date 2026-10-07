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
				className="ml-auto shrink-0 cursor-pointer whitespace-nowrap rounded-sm border-0 bg-transparent px-1 py-0.5 font-mono text-[11px] leading-none text-text-tertiary hover:bg-surface-4 hover:text-text-secondary"
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
