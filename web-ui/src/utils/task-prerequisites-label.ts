import type { TaskPrerequisiteStatus } from "@runtime-task-state";

export interface TaskPrerequisiteLabel {
	text: string;
	/** Every id it is still waiting on, for the tooltip. */
	detail: string;
	tone: "done" | "waiting" | "blocked";
}

/** What a Backlog card shows about its prerequisites (fan-in: it starts once all of them are Done). */
export function getTaskPrerequisiteLabel(status: TaskPrerequisiteStatus): TaskPrerequisiteLabel {
	const remaining = status.total - status.done;
	if (remaining === 0) {
		return {
			text: status.total === 1 ? "Prerequisite done" : `All ${status.total} prerequisites done`,
			detail: "Every prerequisite is Done; start the card by hand.",
			tone: "done",
		};
	}
	const parts: string[] = [];
	if (status.waitingOnTaskIds.length > 0) {
		parts.push(`Waiting on ${status.waitingOnTaskIds.join(", ")}.`);
	}
	if (status.missingTaskIds.length > 0) {
		parts.push(
			`Deleted before Done: ${status.missingTaskIds.join(", ")}. This card won't start by itself; start it by hand or remove the link.`,
		);
	}
	return {
		text: `Waiting on ${remaining} of ${status.total}${status.missingTaskIds.length > 0 ? ` (${status.missingTaskIds.length} deleted)` : ""}`,
		detail: parts.join(" "),
		tone: status.missingTaskIds.length > 0 ? "blocked" : "waiting",
	};
}
