import { Folder, FolderSearch, GitBranch } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

import { FormError } from "@/components/add-project/form-error";
import { ProjectRootPrefix } from "@/components/add-project/project-root-prefix";
import { type AddProjectModeProps, MODE_BODY_CLASS } from "@/components/add-project/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeDirectoryListEntry } from "@/runtime/types";
import { isDirectoryPickerUnavailableError } from "@/utils/directory-picker";
import { isLocalhostAccess } from "@/utils/localhost-detection";

/**
 * Open folder: pick an existing folder directly under the projects root (one level, listed by the server so it
 * works on a headless pod), or on localhost through the native picker. A folder without git is offered git init.
 */
export function OpenFolderMode({
	workspaceId,
	roots,
	root,
	onRootChange,
	onBusyChange,
	onCancel,
	onAdded,
}: AddProjectModeProps): ReactElement {
	const [entries, setEntries] = useState<RuntimeDirectoryListEntry[] | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [pendingGitInitPath, setPendingGitInitPath] = useState<string | null>(null);
	const [isAdding, setIsAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setEntries(null);
		setListError(null);
		setSelectedPath(null);
		setPendingGitInitPath(null);
		void (async () => {
			try {
				const response = await getRuntimeTrpcClient(workspaceId).projects.listDirectoryContents.query({
					path: root,
				});
				if (cancelled) {
					return;
				}
				if (response.ok) {
					setEntries(response.entries);
				} else {
					setEntries([]);
					setListError(response.error ?? `Could not list ${root}.`);
				}
			} catch (caught) {
				if (!cancelled) {
					setEntries([]);
					setListError(caught instanceof Error ? caught.message : String(caught));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [root, workspaceId]);

	const addPath = async (path: string, initializeGit: boolean) => {
		setIsAdding(true);
		onBusyChange(true);
		setError(null);
		try {
			const added = await getRuntimeTrpcClient(workspaceId).projects.add.mutate({ path, initializeGit });
			if (!added.ok || !added.project) {
				if (added.requiresGitInitialization) {
					setPendingGitInitPath(path);
					return;
				}
				setError(added.error ?? "Could not add project.");
				return;
			}
			setPendingGitInitPath(null);
			onAdded(added.project.id);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setIsAdding(false);
			onBusyChange(false);
		}
	};

	const handleBrowse = async () => {
		setError(null);
		try {
			const picked = await getRuntimeTrpcClient(workspaceId).projects.pickDirectory.mutate();
			if (picked.ok && picked.path) {
				await addPath(picked.path, false);
				return;
			}
			if (picked.error === "No directory was selected.") {
				return;
			}
			setError(
				isDirectoryPickerUnavailableError(picked.error)
					? "The native folder picker isn't available on this machine; pick a folder from the list."
					: (picked.error ?? "Could not pick a folder."),
			);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		}
	};

	const selectedName = selectedPath ? (entries?.find((entry) => entry.path === selectedPath)?.name ?? "") : "";

	return (
		<>
			<div className={MODE_BODY_CLASS}>
				<div>
					<span className="block text-[12px] text-text-secondary mb-1.5">Project folder</span>
					<div className="flex items-center h-8 rounded-md border border-border bg-surface-2">
						<ProjectRootPrefix roots={roots} value={root} onChange={onRootChange} disabled={isAdding} />
						<span
							data-testid="open-folder-selection"
							className={cn(
								"flex-1 min-w-0 truncate px-0.5 pr-2.5 text-[13px] font-mono",
								selectedName ? "text-text-primary" : "text-text-tertiary",
							)}
						>
							{selectedName || "pick a folder below"}
						</span>
					</div>
				</div>
				<div
					role="listbox"
					aria-label="Folders in the projects root"
					className="max-h-48 overflow-y-auto rounded-md border border-border bg-surface-2"
				>
					{entries === null ? (
						<div className="flex items-center gap-2 px-3 py-2 text-[13px] text-text-secondary">
							<Spinner size={14} />
							Loading folders…
						</div>
					) : entries.length === 0 ? (
						<p className="m-0 px-3 py-2 text-[13px] text-text-secondary">
							{listError ?? `No folders in ${root}/ yet. Use "New project" or "Clone" to make one.`}
						</p>
					) : (
						entries.map((entry) => (
							<div
								key={entry.path}
								role="option"
								tabIndex={0}
								aria-selected={entry.path === selectedPath}
								onClick={() => {
									setSelectedPath(entry.path);
									setPendingGitInitPath(null);
									setError(null);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										setSelectedPath(entry.path);
										setPendingGitInitPath(null);
									}
								}}
								onDoubleClick={() => void addPath(entry.path, false)}
								className={cn(
									"flex items-center gap-2 px-3 py-1.5 text-[13px] text-text-primary cursor-pointer",
									entry.path === selectedPath ? "bg-surface-4" : "hover:bg-surface-3",
								)}
							>
								{entry.isGitRepository ? (
									<GitBranch size={14} className="text-accent shrink-0" aria-label="Git repository" />
								) : (
									<Folder size={14} className="text-text-secondary shrink-0" />
								)}
								<span className="truncate font-mono">{entry.name}</span>
							</div>
						))
					)}
				</div>
				{isLocalhostAccess() ? (
					<Button
						variant="ghost"
						size="sm"
						icon={<FolderSearch size={14} />}
						onClick={() => void handleBrowse()}
						disabled={isAdding}
						className="self-start"
					>
						Browse on this computer…
					</Button>
				) : null}
				{pendingGitInitPath !== null ? (
					<div className="rounded-md border border-status-orange/30 bg-status-orange/5 px-3 py-2.5 flex flex-col gap-2">
						<p className="m-0 text-[13px] text-text-primary">
							This directory is not a git repository. Kanban requires git to manage worktrees for tasks.
						</p>
						<p className="m-0 font-mono text-[11px] text-text-secondary break-all">{pendingGitInitPath}</p>
					</div>
				) : null}
				<FormError message={error} />
				<p id="add-project-dialog-description" className="sr-only">
					Add a project by opening a folder in the projects root, cloning a git repository, or creating a new one.
				</p>
			</div>
			<DialogFooter>
				<Button variant="default" onClick={onCancel} disabled={isAdding}>
					Cancel
				</Button>
				{pendingGitInitPath === null ? (
					<Button
						variant="primary"
						onClick={() => {
							if (selectedPath) void addPath(selectedPath, false);
						}}
						disabled={!selectedPath || isAdding}
					>
						{isAdding ? (
							<>
								<Spinner size={14} />
								Adding...
							</>
						) : (
							"Add Project"
						)}
					</Button>
				) : (
					<Button variant="primary" onClick={() => void addPath(pendingGitInitPath, true)} disabled={isAdding}>
						{isAdding ? (
							<>
								<Spinner size={14} />
								Initializing...
							</>
						) : (
							"Initialize Git Repository"
						)}
					</Button>
				)}
			</DialogFooter>
		</>
	);
}
