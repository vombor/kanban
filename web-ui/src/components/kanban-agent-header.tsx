import { Bot } from "lucide-react";

/**
 * Header of the sidebar's agent panel (the selected project's home-agent session):
 * "Kanban Agent" on the left, the project's agent on the right.
 */
export function KanbanAgentHeader({ agentLabel }: { agentLabel: string | null }): React.ReactElement {
	return (
		<div
			className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs font-medium text-text-primary"
			data-testid="kanban-agent-header"
		>
			<Bot size={14} className="shrink-0 text-text-secondary" />
			<span className="shrink-0">Kanban Agent</span>
			{agentLabel ? (
				<span className="ml-auto min-w-0 truncate font-normal text-text-secondary" data-testid="kanban-agent-name">
					{agentLabel}
				</span>
			) : null}
		</div>
	);
}
