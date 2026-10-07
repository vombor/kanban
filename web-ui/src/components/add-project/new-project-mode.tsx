import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { slugifyProjectName } from "@runtime-project-paths";
import { Check } from "lucide-react";
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

const INPUT_CLASS =
	"w-full h-8 px-2.5 text-[13px] rounded-md border border-border bg-surface-2 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent";

/** New project: a name, a directory under the projects root (default: the slugified name), git init, README commit. */
export function NewProjectMode({
	workspaceId,
	roots,
	root,
	onRootChange,
	onBusyChange,
	onCancel,
	onAdded,
}: AddProjectModeProps): ReactElement {
	const [projectName, setProjectName] = useState("");
	const [directoryName, setDirectoryName] = useState("");
	const [isDirectoryEdited, setIsDirectoryEdited] = useState(false);
	const [initialBranch, setInitialBranch] = useState("main");
	const [initialCommit, setInitialCommit] = useState(true);
	const [isCreating, setIsCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const timer = setTimeout(() => nameInputRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	const effectiveDirectory = isDirectoryEdited ? directoryName : slugifyProjectName(projectName);
	const status = useProjectNameCheck({ root, name: effectiveDirectory, workspaceId, enabled: true });
	const targetPath = toServerAbsolute(root, effectiveDirectory);
	const canCreate =
		!isCreating && projectName.trim().length > 0 && initialBranch.trim().length > 0 && isProjectNameUsable(status);

	const handleCreate = async () => {
		if (!canCreate) {
			return;
		}
		setIsCreating(true);
		onBusyChange(true);
		setError(null);
		try {
			const created = await getRuntimeTrpcClient(workspaceId).projects.create.mutate({
				path: targetPath,
				name: projectName.trim(),
				initialBranch: initialBranch.trim(),
				initialCommit,
			});
			if (!created.ok || !created.project) {
				setError(created.error ?? "Could not create the project.");
				return;
			}
			showAppToast({
				intent: "success",
				message: [`Created ${targetPath}.`, ...created.notes].join(" "),
				timeout: created.notes.length > 0 ? 12000 : 4000,
			});
			onAdded(created.project.id);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setIsCreating(false);
			onBusyChange(false);
		}
	};

	return (
		<>
			<form
				className={MODE_BODY_CLASS}
				onSubmit={(event) => {
					event.preventDefault();
					void handleCreate();
				}}
			>
				<div>
					<label htmlFor="add-project-new-name-input" className="block text-[12px] text-text-secondary mb-1.5">
						Project name
					</label>
					<input
						ref={nameInputRef}
						id="add-project-new-name-input"
						type="text"
						value={projectName}
						onChange={(event) => {
							setProjectName(event.target.value);
							setError(null);
						}}
						placeholder="My new project"
						className={INPUT_CLASS}
						disabled={isCreating}
						aria-label="Project name"
					/>
				</div>
				<div>
					<label htmlFor="add-project-new-dir-input" className="block text-[12px] text-text-secondary mb-1.5">
						Directory
					</label>
					<ProjectNameField
						id="add-project-new-dir-input"
						ariaLabel="New project directory name"
						roots={roots}
						root={root}
						onRootChange={onRootChange}
						value={effectiveDirectory}
						onChange={(value) => {
							setDirectoryName(value);
							setIsDirectoryEdited(true);
							setError(null);
						}}
						placeholder="my-new-project"
						disabled={isCreating}
					/>
					<ProjectNameStatus status={status} path={targetPath} />
				</div>
				<div className="grid grid-cols-2 gap-2 items-end">
					<div>
						<label
							htmlFor="add-project-new-branch-input"
							className="block text-[12px] text-text-secondary mb-1.5"
						>
							Initial branch
						</label>
						<input
							id="add-project-new-branch-input"
							type="text"
							value={initialBranch}
							onChange={(event) => setInitialBranch(event.target.value)}
							className={`${INPUT_CLASS} font-mono`}
							disabled={isCreating}
							aria-label="Initial branch"
						/>
					</div>
					<label
						htmlFor="add-project-new-commit-checkbox"
						className="flex h-8 items-center gap-2 text-[13px] text-text-primary cursor-pointer"
					>
						<RadixCheckbox.Root
							id="add-project-new-commit-checkbox"
							aria-label="Initial commit"
							checked={initialCommit}
							disabled={isCreating}
							onCheckedChange={(checked) => setInitialCommit(checked === true)}
							className="flex h-4 w-4 cursor-pointer items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
						>
							<RadixCheckbox.Indicator>
								<Check size={12} className="text-white" />
							</RadixCheckbox.Indicator>
						</RadixCheckbox.Root>
						<span>Initial commit (README.md)</span>
					</label>
				</div>
				<p className="m-0 text-[12px] text-text-tertiary">
					Kanban runs git init{initialCommit ? " and commits a README.md, so task worktrees have a base" : ""}.
					{initialCommit ? "" : " Tasks can't start until the repo has a first commit."}
				</p>
				<FormError message={error} />
			</form>
			<DialogFooter>
				<Button variant="default" onClick={onCancel} disabled={isCreating}>
					Cancel
				</Button>
				<Button variant="primary" onClick={() => void handleCreate()} disabled={!canCreate}>
					{isCreating ? (
						<>
							<Spinner size={14} />
							Creating...
						</>
					) : (
						"Create Project"
					)}
				</Button>
			</DialogFooter>
		</>
	);
}
