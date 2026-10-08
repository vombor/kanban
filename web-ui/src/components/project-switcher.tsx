import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { ProjectTaskCountBadges } from "@/components/project-task-count-badges";
import { cn } from "@/components/ui/cn";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

/**
 * The global project dropdown: picking a project switches the board (and the sidebar's Kanban Agent with it).
 * Radix Select gives arrow keys, type-ahead on the project name (`ItemText`) and Esc.
 */
export function ProjectSwitcher({
	projects,
	currentProjectId,
	isLoading,
	disabled = false,
	onSelectProject,
}: {
	projects: RuntimeProjectSummary[];
	currentProjectId: string | null;
	isLoading: boolean;
	disabled?: boolean;
	onSelectProject: (projectId: string) => void;
}): React.ReactElement {
	if (projects.length === 0 && isLoading) {
		return <div className="kb-skeleton h-8 min-w-0 flex-1 rounded-md" data-testid="project-switcher-skeleton" />;
	}
	const currentProject = projects.find((project) => project.id === currentProjectId) ?? null;
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
					"flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5",
					"text-left text-sm font-medium text-text-primary outline-none hover:bg-surface-3",
					"focus-visible:border-border-focus data-[state=open]:border-border-focus",
					"disabled:cursor-default disabled:opacity-60",
				)}
			>
				<span className="min-w-0 flex-1 truncate">
					<RadixSelect.Value placeholder={<span className="text-text-secondary">Select a project</span>} />
				</span>
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
							<ProjectOptionCard key={project.id} project={project} />
						))}
					</RadixSelect.Viewport>
				</RadixSelect.Content>
			</RadixSelect.Portal>
		</RadixSelect.Root>
	);
}

function ProjectOptionCard({ project }: { project: RuntimeProjectSummary }): React.ReactElement {
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
				<RadixSelect.ItemIndicator className="shrink-0">
					<Check size={14} className="text-accent" />
				</RadixSelect.ItemIndicator>
			</div>
			<div className="truncate font-mono text-[10px] text-text-secondary">{formatPathForDisplay(project.path)}</div>
			<ProjectTaskCountBadges taskCounts={project.taskCounts} className="mt-0.5" />
		</RadixSelect.Item>
	);
}
