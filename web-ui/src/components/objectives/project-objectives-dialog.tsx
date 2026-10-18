import { RefreshCw, Target } from "lucide-react";
import { ObjectiveControls } from "@/components/objectives/objective-controls";
import { ObjectiveCreateForm } from "@/components/objectives/objective-create-form";
import { ObjectiveLimitsForm } from "@/components/objectives/objective-limits-form";
import { ObjectiveReadout } from "@/components/objectives/objective-readout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useProjectObjectives } from "@/hooks/use-project-objectives";

export function ProjectObjectivesDialog({
	workspaceId,
	projectName,
	onClose,
}: {
	workspaceId: string;
	projectName: string;
	onClose: () => void;
}): React.ReactElement {
	const view = useProjectObjectives(workspaceId);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			contentClassName="max-w-4xl"
			contentAriaDescribedBy="objective-scope-description"
		>
			<DialogHeader title={`Objectives · ${projectName}`} icon={<Target size={16} />} />
			<DialogBody className="flex flex-col gap-3">
				<p id="objective-scope-description" className="text-[13px] text-text-secondary">
					Durable project-scoped objectives and owner evidence. Not a new orchestrator. Requirements are
					reference/acceptance criteria, never plan execution approval.
				</p>
				{view.error ? (
					<p role="alert" className="text-[13px] text-status-red">
						{view.error}
					</p>
				) : null}
				{view.retryAvailable ? (
					<Button
						disabled={view.busy || view.reading}
						onClick={() => {
							void view.retry();
						}}
					>
						Retry exact objective mutation
					</Button>
				) : null}
				<ObjectiveCreateForm busy={view.busy || view.reading} onCreate={view.create} />
				<div className="grid min-h-64 gap-4 md:grid-cols-[minmax(180px,1fr)_minmax(0,2fr)]">
					<aside aria-label="Project objective list" className="flex flex-col gap-2">
						{view.loading ? (
							<span className="inline-flex items-center gap-2 text-xs text-text-secondary">
								<Spinner size={14} />
								Loading objectives
							</span>
						) : null}
						{!view.loading && !view.listError && !view.objectives.length ? (
							<p className="text-[13px] text-text-secondary">
								No objectives yet. Use the project's <code>kanban objective create</code> command to pin
								requirements to existing dev tasks. Creating one does not start those tasks.
							</p>
						) : null}
						{view.objectives.map((objective) => (
							<Button
								key={objective.id}
								variant={view.selectedId === objective.id ? "primary" : "default"}
								aria-pressed={view.selectedId === objective.id}
								className="h-auto justify-start text-left"
								disabled={view.busy}
								onClick={() => {
									void view.select(objective.id);
								}}
							>
								<span className="min-w-0 break-words">
									<span className="block">{objective.title}</span>
									<span className="block text-xs opacity-75">{objective.status.replaceAll("_", " ")}</span>
								</span>
							</Button>
						))}
						<div className="flex items-center gap-2 text-xs text-text-secondary">
							<Button disabled={view.offset === 0 || view.loading || view.busy} onClick={view.previous}>
								Previous
							</Button>
							<span>{view.total} objectives</span>
							<Button disabled={view.offset + 20 >= view.total || view.loading || view.busy} onClick={view.next}>
								Next
							</Button>
						</div>
					</aside>
					<div className="min-w-0">
						{view.reading ? (
							<p role="status" className="inline-flex items-center gap-2 text-xs text-text-secondary">
								<Spinner size={14} />
								Reading retained evidence
							</p>
						) : null}
						{view.detail ? (
							<div className="flex flex-col gap-3">
								<ObjectiveReadout data={view.detail} />
								<ObjectiveLimitsForm
									key={`limits:${view.detail.objective.id}`}
									objective={view.detail.objective}
									available={view.detail.admissionScopeAvailable}
									busy={view.busy || view.reading}
									onSave={view.limits}
								/>
								{view.detail.admissionScopeAvailable ? (
									<ObjectiveControls
										key={`controls:${view.detail.objective.id}`}
										objective={view.detail.objective}
										busy={view.busy || view.reading}
										onControl={view.control}
										onLink={view.link}
									/>
								) : null}
							</div>
						) : !view.reading && !view.selectedId ? (
							<p className="text-[13px] text-text-tertiary">
								Select an objective to inspect pinned requirements, lineage, uncertainty and verified receipts.
							</p>
						) : null}
					</div>
				</div>
			</DialogBody>
			<DialogFooter>
				<Button
					icon={<RefreshCw size={14} />}
					disabled={view.loading || view.busy}
					onClick={() => {
						void view.refresh();
					}}
				>
					Reload list
				</Button>
				<Button
					disabled={!view.detail || view.busy || view.reading}
					onClick={() => {
						void view.recheck();
					}}
				>
					{view.busy ? "Rechecking retained facts…" : "Recheck retained facts"}
				</Button>
				<Button onClick={onClose}>Close</Button>
			</DialogFooter>
		</Dialog>
	);
}
