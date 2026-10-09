// What a request refused by project isolation tried to do, in words, so a refusal names the action that was refused
// (issue #6: a card create refused as "register a Kanban project"). Actions are tRPC paths (`runtime.startTaskSession`),
// `cli <command path>` from the CLI's in-process guard, or `websocket`; anything not listed is named as it is.

const ACTION_NAMES: Record<string, string> = {
	"runtime.startTaskSession": "start a task",
	"runtime.stopTaskSession": "stop a task",
	"runtime.sendTaskSessionInput": "type into a task's terminal",
	"runtime.deliverTaskInput": "send input to a task",
	"runtime.startShellSession": "open a shell terminal",
	"workspace.getState": "read the board",
	"workspace.saveState": "save the board",
	"workspace.notifyStateUpdated": "refresh the board",
	"workspace.ensureWorktree": "create a task's worktree",
	"workspace.trashTask": "move a task to Done",
	"workspace.deleteWorktree": "delete a task's worktree",
	"workspace.getDevAssignment": "read the kit's dev assignment",
	"projects.add": "open the already registered project",
	"shortcuts.add": "add or change a shortcut",
	"shortcuts.remove": "remove a shortcut",
	"shortcuts.replace": "save the shortcut list",
	"shortcuts.prepareRun": "get a port for a shortcut run",
	websocket: "watch the board or a terminal",
	"cli task create": "create a task",
	"cli task start": "start a task",
	"cli task update": "update a task",
	"cli task list": "list tasks",
	"cli task trash": "move a task to Done",
	"cli task delete": "delete a task",
	"cli task send": "send input to a task",
	"cli task resume": "resume a task",
	"cli task link": "link tasks",
	"cli task unlink": "unlink tasks",
};

/** `create a task in project foo`: the refused action and the project it was refused in. */
export function describeIsolationAction(action: string, workspaceId: string): string {
	const known = ACTION_NAMES[action.trim()];
	if (known) {
		return `${known} in project ${workspaceId}`;
	}
	const command = action.startsWith("cli ") ? `kanban ${action.slice(4)}` : action;
	return `\`${command}\` in project ${workspaceId}`;
}
