import { useEffect, useState } from "react";

import { FormError } from "@/components/add-project/form-error";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useProjectRename } from "@/hooks/use-project-rename";
import type { RuntimeProjectSummary } from "@/runtime/types";

/** The display name's longest form (PROJECT_DISPLAY_NAME_MAX_LENGTH, src/projects/project-display-name.ts). */
const NAME_MAX_LENGTH = 40;

/** Renames a project's display name (`kanban project rename`); the workspace id and directory stay. */
export function RenameProjectDialog({
	project,
	onClose,
}: {
	/** The project to rename; null = closed. */
	project: RuntimeProjectSummary | null;
	onClose: () => void;
}): React.ReactElement {
	const { isSaving, error, clearError, rename } = useProjectRename();
	const [name, setName] = useState("");

	useEffect(() => {
		if (project) {
			setName(project.name);
			clearError();
		}
	}, [project, clearError]);

	const directoryName = project?.path.replace(/\/+$/g, "").split("/").pop() ?? "";

	const submit = async () => {
		if (!project || isSaving) {
			return;
		}
		if (await rename(project.id, name)) {
			onClose();
		}
	};

	return (
		<Dialog
			open={project !== null}
			onOpenChange={(open) => {
				if (!open && !isSaving) {
					onClose();
				}
			}}
		>
			<DialogHeader title="Rename project" />
			<form
				className="flex flex-col min-h-0"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<DialogBody className="flex flex-col gap-3">
					<div>
						<label htmlFor="rename-project-name-input" className="block text-[12px] text-text-secondary mb-1.5">
							Display name
						</label>
						<input
							id="rename-project-name-input"
							type="text"
							value={name}
							maxLength={NAME_MAX_LENGTH}
							onChange={(event) => {
								setName(event.target.value);
								clearError();
							}}
							placeholder={directoryName}
							className="w-full h-8 px-2.5 text-[13px] rounded-md border border-border bg-surface-2 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
							disabled={isSaving}
						/>
						<p className="mt-1.5 text-[12px] text-text-tertiary">
							Letters, digits, spaces and . _ - ' &amp; ( ) +. Leave it empty to show the directory name. The
							workspace id ({project?.id}) and the directory stay as they are.
						</p>
					</div>
					<FormError message={error} />
				</DialogBody>
				<DialogFooter>
					<Button variant="default" type="button" disabled={isSaving} onClick={onClose}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" disabled={isSaving}>
						{isSaving ? (
							<>
								<Spinner size={14} />
								Saving...
							</>
						) : (
							"Rename"
						)}
					</Button>
				</DialogFooter>
			</form>
		</Dialog>
	);
}
