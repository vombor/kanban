import { Pause } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";

const QA_PAUSED_TOOLTIP =
	"This project's QA pipeline is paused: new QA cards wait in Backlog, no PASS lands and no rework is sent. Resume with kanban pipeline resume.";

/**
 * The project's QA pipeline is paused (`kanban pipeline pause`, the project summary's `pipelinePaused`). Inside a
 * list option (the project switcher) it explains itself with a plain `title`: a Tooltip there would sit in the
 * option's own pointer handling.
 */
export function QaPausedTag({
	className,
	tooltip = true,
}: {
	className?: string;
	tooltip?: boolean;
}): React.ReactElement {
	const tag = (
		<span
			className={cn(
				"kb-navbar-tag inline-flex shrink-0 items-center gap-1 rounded border border-status-orange/30 bg-status-orange/10 px-1.5 py-0.5 text-xs text-status-orange",
				className,
			)}
			title={tooltip ? undefined : QA_PAUSED_TOOLTIP}
			data-testid="qa-paused-tag"
		>
			<Pause size={12} />
			QA paused
		</span>
	);
	return tooltip ? <Tooltip content={QA_PAUSED_TOOLTIP}>{tag}</Tooltip> : tag;
}
