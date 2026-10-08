import { cn } from "@/components/ui/cn";
import type { RuntimeProjectSummary } from "@/runtime/types";

interface TaskCountBadge {
	id: keyof RuntimeProjectSummary["taskCounts"];
	title: string;
	shortLabel: string;
	toneClassName: string;
}

const TASK_COUNT_BADGES: readonly TaskCountBadge[] = [
	{ id: "backlog", title: "Backlog", shortLabel: "B", toneClassName: "bg-text-primary/15 text-text-primary" },
	{ id: "in_progress", title: "In Progress", shortLabel: "IP", toneClassName: "bg-accent/20 text-accent" },
	{ id: "review", title: "Review", shortLabel: "R", toneClassName: "bg-accent-2/20 text-accent-2" },
	{ id: "trash", title: "Done", shortLabel: "D", toneClassName: "bg-status-red/20 text-status-red" },
];

/** The board stats of a project: one badge per column that has cards. */
export function ProjectTaskCountBadges({
	taskCounts,
	className,
}: {
	taskCounts: RuntimeProjectSummary["taskCounts"];
	className?: string;
}): React.ReactElement | null {
	const badges = TASK_COUNT_BADGES.filter((badge) => taskCounts[badge.id] > 0);
	if (badges.length === 0) {
		return null;
	}
	return (
		<div className={cn("flex gap-1", className)}>
			{badges.map((badge) => (
				<span
					key={badge.id}
					className={cn(
						"inline-flex items-center gap-1 rounded-full text-[10px] px-1.5 py-px font-medium",
						badge.toneClassName,
					)}
					title={badge.title}
					data-column={badge.id}
				>
					<span className="sr-only">{badge.title}: </span>
					<span aria-hidden>{badge.shortLabel}</span>
					<span aria-hidden className="opacity-40">
						|
					</span>
					<span>{taskCounts[badge.id]}</span>
				</span>
			))}
		</div>
	);
}
