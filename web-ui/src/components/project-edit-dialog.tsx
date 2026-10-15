import { FormError } from "@/components/add-project/form-error";
import { ProjectScriptsEditor } from "@/components/project-scripts-editor";
import { ProjectSecretFields } from "@/components/project-secret-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useProjectDefinition } from "@/hooks/use-project-definition";
import type { RuntimeProjectSummary } from "@/runtime/types";

/** Edits user-owned project settings; the workspace id and directory remain stable. */
export function ProjectEditDialog({
	project,
	onClose,
}: {
	project: RuntimeProjectSummary | null;
	onClose: () => void;
}): React.ReactElement {
	const draft = useProjectDefinition(project, onClose);
	const directoryName = project?.path.replace(/\/+$/g, "").split("/").pop() ?? "";
	return (
		<Dialog
			open={project !== null}
			onOpenChange={(open) => {
				if (!open && !draft.saving) onClose();
			}}
		>
			<DialogHeader title="Edit Project" />
			<form
				className="flex flex-col min-h-0"
				onSubmit={(event) => {
					event.preventDefault();
					void draft.submit();
				}}
			>
				<DialogBody className="flex flex-col gap-3">
					<div>
						<label htmlFor="edit-project-name-input" className="block text-[12px] text-text-secondary mb-1.5">
							Display name
						</label>
						<input
							id="edit-project-name-input"
							type="text"
							value={draft.name}
							maxLength={40}
							onChange={(event) => {
								draft.setName(event.target.value);
								draft.clearError();
							}}
							placeholder={directoryName}
							className="w-full h-8 px-2.5 text-[13px] rounded-md border border-border bg-surface-2 text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
							disabled={draft.busy}
						/>
						<p className="mt-1.5 text-[12px] text-text-tertiary">
							Leave it empty to show the directory name. Workspace id: {project?.id}.
						</p>
					</div>
					<FormError message={draft.error} />
					<ProjectScriptsEditor
						scripts={draft.scripts}
						onChange={draft.setScripts}
						disabled={draft.busy || draft.loadFailed}
					/>
					<ProjectSecretFields
						values={draft.secrets}
						onChange={draft.setSecrets}
						existing={draft.metadata}
						removed={draft.removed}
						onRemove={draft.remove}
						disabled={draft.busy || draft.loadFailed}
					/>
				</DialogBody>
				<DialogFooter>
					<Button variant="default" type="button" disabled={draft.saving} onClick={onClose}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" disabled={draft.busy || draft.loadFailed}>
						{draft.saving ? (
							<>
								<Spinner size={14} />
								Saving...
							</>
						) : (
							"Save"
						)}
					</Button>
				</DialogFooter>
			</form>
		</Dialog>
	);
}
