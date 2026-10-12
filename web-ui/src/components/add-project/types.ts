import type { ReactElement } from "react";

/** What every add-project mode gets from the dialog. */
export interface AddProjectModeProps {
	workspaceId: string | null;
	/** The allowed projects roots; `root` is the selected one. */
	roots: string[];
	root: string;
	onRootChange: (root: string) => void;
	onBusyChange: (busy: boolean) => void;
	onCancel: () => void;
	onAdded: (projectId: string) => void;
	/** The routing kit picked for the new project (sent as `kit`; a project already added keeps its own). */
	kitName: string;
	/** The dialog's kit picker, shown in the mode's form. */
	kitPicker: ReactElement;
}

/** The body of a mode, under the dialog's mode tabs and above the mode's own footer. */
export const MODE_BODY_CLASS = "flex flex-col gap-3 px-4 pb-4 bg-surface-1";
