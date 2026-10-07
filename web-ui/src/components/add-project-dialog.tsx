import { FolderOpen, FolderPlus, GitBranch, Search } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { CloneMode } from "@/components/add-project/clone-mode";
import { FormError } from "@/components/add-project/form-error";
import { NewProjectMode } from "@/components/add-project/new-project-mode";
import { OpenFolderMode } from "@/components/add-project/open-folder-mode";
import { type AddProjectModeProps, MODE_BODY_CLASS } from "@/components/add-project/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useProjectRoots } from "@/hooks/use-project-roots";

type AddProjectMode = "open" | "clone" | "new";

const MODES: ReadonlyArray<{ id: AddProjectMode; label: string; icon: ReactElement }> = [
	{ id: "open", label: "Open folder", icon: <Search size={12} /> },
	{ id: "clone", label: "Clone from URL", icon: <GitBranch size={12} /> },
	{ id: "new", label: "New project", icon: <FolderPlus size={12} /> },
];

export interface AddProjectDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onProjectAdded: (projectId: string) => void;
	currentProjectId: string | null;
}

/**
 * Add a project: open an existing folder, clone a repo, or create a new one. Every path starts with a projects
 * root (`projects.roots`, read-only prefix); the server checks the full path again on every add.
 */
export function AddProjectDialog({
	open,
	onOpenChange,
	onProjectAdded,
	currentProjectId,
}: AddProjectDialogProps): ReactElement {
	const [mode, setMode] = useState<AddProjectMode>("open");
	const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
	const [isBusy, setIsBusy] = useState(false);
	const projectRoots = useProjectRoots(open, currentProjectId);
	const root =
		selectedRoot && projectRoots.roots.includes(selectedRoot) ? selectedRoot : (projectRoots.roots[0] ?? null);

	useEffect(() => {
		if (!open) {
			return;
		}
		setMode("open");
		setSelectedRoot(null);
		setIsBusy(false);
	}, [open]);

	const handleAdded = useCallback(
		(projectId: string) => {
			onProjectAdded(projectId);
			onOpenChange(false);
		},
		[onOpenChange, onProjectAdded],
	);

	// Keep Escape in a focused text field from closing the dialog; blur the field instead.
	const handleDialogEscapeKeyDown = useCallback((event: KeyboardEvent) => {
		const active = document.activeElement;
		if (active instanceof HTMLInputElement) {
			event.preventDefault();
			active.blur();
		}
	}, []);

	const modeProps: AddProjectModeProps | null = root
		? {
				workspaceId: currentProjectId,
				roots: projectRoots.roots,
				root,
				onRootChange: setSelectedRoot,
				onBusyChange: setIsBusy,
				onCancel: () => onOpenChange(false),
				onAdded: handleAdded,
			}
		: null;

	return (
		<Dialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen && isBusy) {
					return;
				}
				onOpenChange(isOpen);
			}}
			contentClassName="max-w-lg"
			contentAriaDescribedBy="add-project-dialog-description"
			onEscapeKeyDown={handleDialogEscapeKeyDown}
		>
			<DialogHeader title="Add Project" icon={<FolderOpen size={16} />} />
			<div className="p-4 pb-3 bg-surface-1">
				<div className="rounded-md bg-surface-2 p-1">
					<div role="tablist" aria-label="How to add the project" className="grid grid-cols-3 gap-1">
						{MODES.map((item) => (
							<button
								key={item.id}
								type="button"
								role="tab"
								aria-selected={mode === item.id}
								onClick={() => setMode(item.id)}
								disabled={isBusy}
								className={cn(
									"cursor-pointer rounded-sm px-2 py-1 text-xs font-medium inline-flex items-center justify-center gap-1.5",
									mode === item.id
										? "bg-surface-4 text-text-primary"
										: "text-text-secondary hover:text-text-primary",
									isBusy && "cursor-not-allowed opacity-50",
								)}
							>
								{item.icon}
								{item.label}
							</button>
						))}
					</div>
				</div>
			</div>
			{modeProps === null ? (
				<div className={MODE_BODY_CLASS}>
					{projectRoots.isLoading ? (
						<div className="flex items-center gap-2 text-[13px] text-text-secondary">
							<Spinner size={14} />
							Loading the projects root…
						</div>
					) : (
						<FormError
							message={
								projectRoots.error ??
								"No projects root is available (setting projects.roots), so no project can be added."
							}
						/>
					)}
				</div>
			) : mode === "open" ? (
				<OpenFolderMode {...modeProps} />
			) : mode === "clone" ? (
				<CloneMode {...modeProps} />
			) : (
				<NewProjectMode {...modeProps} />
			)}
			{modeProps === null ? (
				<DialogFooter>
					<Button variant="default" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
				</DialogFooter>
			) : null}
		</Dialog>
	);
}
