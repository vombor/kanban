import { Bot } from "lucide-react";
import { OrchestratorWaitBadge } from "@/components/orchestrator-wait-badge";
import type { RuntimeOrchestratorWait } from "@/runtime/types";

/**
 * Header of the sidebar's agent panel (the selected project's home-agent session):
 * "Kanban Agent" on the left, the project's agent on the right, and a badge while the agent waits for the user.
 */
export function KanbanAgentHeader({
	agentLabel,
	wait = null,
	waitFlashing = false,
}: {
	agentLabel: string | null;
	wait?: RuntimeOrchestratorWait | null;
	waitFlashing?: boolean;
}): React.ReactElement {
	return (
		<div
			className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs font-medium text-text-primary"
			data-testid="kanban-agent-header"
		>
			<Bot size={14} className="shrink-0 text-text-secondary" />
			<span className="shrink-0">Kanban Agent</span>
			{wait ? <OrchestratorWaitBadge kind={wait.kind} flashing={waitFlashing} /> : null}
			{agentLabel ? (
				<span className="ml-auto min-w-0 truncate font-normal text-text-secondary" data-testid="kanban-agent-name">
					{agentLabel}
				</span>
			) : null}
		</div>
	);
}
