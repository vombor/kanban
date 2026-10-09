import { MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import { cn } from "@/components/ui/cn";
import type { RuntimeUserInputWaitKind } from "@/runtime/types";
import { describeOrchestratorWaitKind } from "@/utils/orchestrator-wait-alerts";

/**
 * A project's orchestrator waits for the user (issue #10): an icon pill, a count pill (`count`, for several
 * projects) or a dot (`variant="dot"`, on the collapsed sidebar's project letters). `flashing` runs the short
 * attention animation a new wait gets once.
 */
export function OrchestratorWaitBadge({
	kind,
	count,
	flashing = false,
	variant = "pill",
	className,
}: {
	kind?: RuntimeUserInputWaitKind;
	count?: number;
	flashing?: boolean;
	variant?: "pill" | "dot";
	className?: string;
}): React.ReactElement {
	const label =
		count !== undefined
			? `${count} ${count === 1 ? "project's" : "projects'"} Kanban Agent waiting for you`
			: `Kanban Agent ${describeOrchestratorWaitKind(kind ?? "question")}`;
	if (variant === "dot") {
		return (
			<span
				role="status"
				aria-label={label}
				title={label}
				data-testid="orchestrator-wait-badge"
				data-flashing={flashing ? "true" : undefined}
				className={cn(
					"block h-2.5 w-2.5 rounded-full border-2 border-surface-1 bg-status-gold",
					flashing && "kb-attention-flash",
					className,
				)}
			/>
		);
	}
	const Icon = kind === "approval" ? ShieldQuestion : MessageCircleQuestion;
	return (
		<span
			role="status"
			aria-label={label}
			title={label}
			data-testid="orchestrator-wait-badge"
			data-flashing={flashing ? "true" : undefined}
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-full bg-status-gold/20 px-1.5 py-px text-[10px] font-medium text-status-gold",
				flashing && "kb-attention-flash",
				className,
			)}
		>
			<Icon size={12} aria-hidden />
			{count !== undefined ? <span aria-hidden>{count}</span> : null}
		</span>
	);
}
