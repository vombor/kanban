import { slugifyProjectName, validateProjectDirectoryName } from "@runtime-project-paths";
import { type ReactElement, useEffect, useRef, useState } from "react";

import { FormError } from "@/components/add-project/form-error";
import { ProjectNameStatus } from "@/components/add-project/project-name-status";
import { ProjectNameField } from "@/components/add-project/project-root-prefix";
import { type AddProjectModeProps, MODE_BODY_CLASS } from "@/components/add-project/types";
import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { isProjectNameUsable, useProjectNameCheck } from "@/hooks/use-project-name-check";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { toServerAbsolute } from "@/utils/server-path";

/** Derive a repo name from a git URL, the default directory name. */
export function deriveRepoNameFromUrl(gitUrl: string): string {
	const trimmed = gitUrl.trim().replace(/\/+$/, "");
	if (!trimmed) {
		return "";
	}
	// Handle SSH-style URLs: git@host:user/repo.git
	const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
	const pathPart = sshMatch?.[1] ?? trimmed;
	const lastSegment = pathPart.split("/").pop() ?? "";
	return lastSegment.endsWith(".git") ? lastSegment.slice(0, -4) : lastSegment;
}

/** Clone from URL into a new (or empty) directory directly under the projects root. */
export function CloneMode({
	workspaceId,
	roots,
	root,
	onRootChange,
	onBusyChange,
	onCancel,
	onAdded,
}: AddProjectModeProps): ReactElement {
	const [gitUrl, setGitUrl] = useState("");
	const [directoryName, setDirectoryName] = useState("");
	const [isCloning, setIsCloning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const urlInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const timer = setTimeout(() => urlInputRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	const repoName = deriveRepoNameFromUrl(gitUrl);
	const derivedName = validateProjectDirectoryName(repoName) === null ? repoName : slugifyProjectName(repoName);
	const effectiveDirectory = directoryName || derivedName;
	const status = useProjectNameCheck({ root, name: effectiveDirectory, workspaceId, enabled: true });
	const targetPath = toServerAbsolute(root, effectiveDirectory);
	const canClone = !isCloning && gitUrl.trim().length > 0 && isProjectNameUsable(status);

	const handleClone = async () => {
		if (!canClone) {
			return;
		}
		setIsCloning(true);
		onBusyChange(true);
		setError(null);
		try {
			const added = await getRuntimeTrpcClient(workspaceId).projects.add.mutate({
				gitUrl: gitUrl.trim(),
				path: targetPath,
			});
			if (!added.ok || !added.project) {
				setError(added.error ?? "Clone failed.");
				return;
			}
			showAppToast({ intent: "success", message: "Repository cloned and added successfully.", timeout: 4000 });
			onAdded(added.project.id);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setIsCloning(false);
			onBusyChange(false);
		}
	};

	return (
		<>
			<form
				className={MODE_BODY_CLASS}
				onSubmit={(event) => {
					event.preventDefault();
					void handleClone();
				}}
			>
				<div>
					<label htmlFor="add-project-git-url-input" className="block text-[12px] text-text-secondary mb-1.5">
						Git repository URL
					</label>
					<input
						ref={urlInputRef}
						type="text"
						id="add-project-git-url-input"
						value={gitUrl}
						onChange={(event) => {
							setGitUrl(event.target.value);
							setError(null);
						}}
						placeholder="e.g. https://github.com/user/repo.git"
						className="w-full h-8 px-2.5 text-[13px] font-mono rounded-md border border-border bg-surface-2 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
						disabled={isCloning}
						aria-label="Git URL input"
					/>
				</div>
				<div>
					<label htmlFor="add-project-clone-dir-input" className="block text-[12px] text-text-secondary mb-1.5">
						Clone into
					</label>
					<ProjectNameField
						id="add-project-clone-dir-input"
						ariaLabel="Clone directory name"
						roots={roots}
						root={root}
						onRootChange={onRootChange}
						value={directoryName}
						onChange={(value) => {
							setDirectoryName(value);
							setError(null);
						}}
						placeholder={derivedName || "repo-name"}
						disabled={isCloning}
					/>
					<ProjectNameStatus status={status} path={targetPath} />
				</div>
				{isCloning ? (
					<div className="flex items-center gap-2 text-[13px] text-text-secondary">
						<Spinner size={14} />
						Cloning repository... This may take a moment.
					</div>
				) : null}
				<FormError message={error} />
			</form>
			<DialogFooter>
				<Button variant="default" onClick={onCancel} disabled={isCloning}>
					Cancel
				</Button>
				<Button variant="primary" onClick={() => void handleClone()} disabled={!canClone}>
					{isCloning ? (
						<>
							<Spinner size={14} />
							Cloning...
						</>
					) : (
						"Clone & Add"
					)}
				</Button>
			</DialogFooter>
		</>
	);
}
