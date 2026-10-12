import { Bot, Inbox } from "lucide-react";
import { OrchestratorWaitBadge } from "@/components/orchestrator-wait-badge";
import type { RuntimeOrchestratorWait } from "@/runtime/types";

/**
 * Header of the sidebar's agent panel (the selected project's home-agent session):
 * "Kanban Agent" on the left, the project's agent on the right, a badge while the agent waits for the user, and how
 * many Kanban notices wait silently for its next prompt (`queuedNotices`).
 */
export function KanbanAgentHeader({
	agentLabel,
	wait = null,
	waitFlashing = false,
	queuedNotices = 0,
}: {
	agentLabel: string | null;
	wait?: RuntimeOrchestratorWait | null;
	waitFlashing?: boolean;
	queuedNotices?: number;
}): React.ReactElement {
	const noticesLabel = `${queuedNotices} Kanban ${queuedNotices === 1 ? "notice" : "notices"} queued`;
	return (
		<div
			className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs font-medium text-text-primary"
			data-testid="kanban-agent-header"
		>
			<Bot size={14} className="shrink-0 text-text-secondary" />
			<span className="shrink-0">Kanban Agent</span>
			{wait ? <OrchestratorWaitBadge kind={wait.kind} flashing={waitFlashing} /> : null}
			{queuedNotices > 0 ? (
				<span
					role="status"
					title={`${noticesLabel} for the agent's next prompt (typed in if still unread later)`}
					data-testid="kanban-agent-queued-notices"
					className="flex shrink-0 items-center gap-1 rounded-full bg-surface-3 px-1.5 py-px font-normal text-text-secondary"
				>
					<Inbox size={12} />
					{noticesLabel}
				</span>
			) : null}
			{agentLabel ? (
				<span className="ml-auto min-w-0 truncate font-normal text-text-secondary" data-testid="kanban-agent-name">
					{agentLabel}
				</span>
			) : null}
		</div>
	);
}
