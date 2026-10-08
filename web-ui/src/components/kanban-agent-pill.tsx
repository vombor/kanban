import { Bot } from "lucide-react";
import { cn } from "@/components/ui/cn";

/**
 * The selected project's Kanban Agent (its home-agent sidebar session), full column width:
 * "Kanban Agent" on the left, the project's agent on the right. Pressed while the agent panel is open.
 */
export function KanbanAgentPill({
	agentLabel,
	isOpen,
	disabled,
	title,
	onClick,
}: {
	agentLabel: string | null;
	isOpen: boolean;
	disabled: boolean;
	title?: string;
	onClick: () => void;
}): React.ReactElement {
	return (
		<div className="rounded-md border border-border bg-surface-2 p-1">
			<button
				type="button"
				aria-pressed={isOpen}
				title={title}
				disabled={disabled}
				onClick={onClick}
				className={cn(
					"flex w-full cursor-pointer items-center gap-2 rounded-sm border px-2 py-1 text-xs font-medium",
					isOpen
						? "border-border bg-surface-4 text-text-primary"
						: "border-transparent text-text-secondary hover:bg-surface-3 hover:text-text-primary",
					"disabled:cursor-not-allowed disabled:opacity-50",
				)}
			>
				<Bot size={14} className="shrink-0" />
				<span className="shrink-0">Kanban Agent</span>
				{agentLabel ? (
					<span
						className="ml-auto min-w-0 truncate font-normal text-text-secondary"
						data-testid="kanban-agent-name"
					>
						{agentLabel}
					</span>
				) : null}
			</button>
		</div>
	);
}
