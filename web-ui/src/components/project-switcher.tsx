import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { OrchestratorWaitBadge } from "@/components/orchestrator-wait-badge";
import { ProjectTaskCountBadges } from "@/components/project-task-count-badges";
import { QaPausedTag } from "@/components/qa-paused-tag";
import { cn } from "@/components/ui/cn";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

/**
 * The global project dropdown: picking a project switches the board (and the sidebar's Kanban Agent with it).
 * Radix Select gives arrow keys, type-ahead on the project name (`ItemText`) and Esc. A project whose orchestrator
 * waits for the user has a badge in the list, and the trigger counts the other projects that do (the current one's
 * shows in the Kanban Agent header).
 */
export function ProjectSwitcher({
	projects,
	currentProjectId,
	isLoading,
	disabled = false,
	flashingProjectIds,
	onSelectProject,
}: {
	projects: RuntimeProjectSummary[];
	currentProjectId: string | null;
	isLoading: boolean;
	disabled?: boolean;
	/** Projects whose orchestrator wait is new (use-orchestrator-wait-alerts.ts). */
	flashingProjectIds?: ReadonlySet<string>;
	onSelectProject: (projectId: string) => void;
}): React.ReactElement {
	if (projects.length === 0 && isLoading) {
		return <div className="kb-skeleton h-8 min-w-0 flex-1 rounded-md" data-testid="project-switcher-skeleton" />;
	}
	const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;
	const otherWaitingProjects = projects.filter(
		(project) => project.orchestratorWait && project.id !== currentProjectId,
	);
	return (
		<RadixSelect.Root
			value={currentProject?.id ?? ""}
			onValueChange={onSelectProject}
			disabled={disabled || projects.length === 0}
		>
			<RadixSelect.Trigger
				aria-label="Project"
				title={currentProject?.name}
				className={cn(
					"flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2",
					"text-left text-sm font-medium text-text-primary outline-none hover:bg-surface-3",
					"focus-visible:border-border-focus data-[state=open]:border-border-focus",
					"disabled:cursor-default disabled:opacity-60",
				)}
			>
				<span className="min-w-0 flex-1 truncate">
					<RadixSelect.Value placeholder={<span className="text-text-secondary">Select a project</span>} />
				</span>
				{otherWaitingProjects.length > 0 ? (
					<OrchestratorWaitBadge
						count={otherWaitingProjects.length}
						flashing={otherWaitingProjects.some((project) => flashingProjectIds?.has(project.id))}
					/>
				) : null}
				<RadixSelect.Icon className="shrink-0">
					<ChevronDown size={14} className="text-text-secondary" />
				</RadixSelect.Icon>
			</RadixSelect.Trigger>
			<RadixSelect.Portal>
				<RadixSelect.Content
					position="popper"
					sideOffset={4}
					align="start"
					className={cn(
						"z-50 w-[var(--radix-select-trigger-width)] min-w-[200px] overflow-hidden",
						"max-h-[min(28rem,var(--radix-select-content-available-height))]",
						"rounded-lg border border-border-bright bg-surface-1 shadow-xl",
					)}
				>
					<RadixSelect.Viewport className="flex flex-col gap-1 p-1">
						{projects.map((project) => (
							<ProjectOptionCard
								key={project.id}
								project={project}
								flashing={flashingProjectIds?.has(project.id) ?? false}
							/>
						))}
					</RadixSelect.Viewport>
				</RadixSelect.Content>
			</RadixSelect.Portal>
		</RadixSelect.Root>
	);
}

function ProjectOptionCard({
	project,
	flashing,
}: {
	project: RuntimeProjectSummary;
	flashing: boolean;
}): React.ReactElement {
	return (
		<RadixSelect.Item
			value={project.id}
			textValue={project.name}
			className={cn(
				"relative flex cursor-pointer flex-col gap-0.5 rounded-md border border-transparent px-2.5 py-1.5 outline-none",
				"data-[highlighted]:bg-surface-3",
				"data-[state=checked]:border-accent data-[state=checked]:bg-accent/10",
			)}
		>
			<div className="flex min-w-0 items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
					<RadixSelect.ItemText>{project.name}</RadixSelect.ItemText>
				</span>
				{project.pipelinePaused ? <QaPausedTag tooltip={false} className="px-1 py-0 text-[10px]" /> : null}
				{project.orchestratorWait ? (
					<OrchestratorWaitBadge kind={project.orchestratorWait.kind} flashing={flashing} />
				) : null}
				<RadixSelect.ItemIndicator className="shrink-0">
					<Check size={14} className="text-accent" />
				</RadixSelect.ItemIndicator>
			</div>
			<div className="truncate font-mono text-[10px] text-text-secondary">{formatPathForDisplay(project.path)}</div>
			<ProjectTaskCountBadges taskCounts={project.taskCounts} className="mt-0.5" />
		</RadixSelect.Item>
	);
}
