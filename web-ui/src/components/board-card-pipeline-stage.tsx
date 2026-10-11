import { AlertTriangle, CheckCircle2, Clock, Loader2, PauseCircle, RotateCcw, Workflow } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimePipelineCardStage, RuntimePipelineCardStageKind } from "@/runtime/types";
import { usePipelineCardStage } from "@/stores/pipeline-card-stage-store";

type StageTone = "active" | "waiting" | "attention" | "done" | "muted";

const TONE_CLASS: Record<StageTone, string> = {
	active: "border-status-blue/30 bg-status-blue/10 text-status-blue",
	waiting: "border-status-gold/30 bg-status-gold/10 text-status-gold",
	attention: "border-status-orange/30 bg-status-orange/10 text-status-orange",
	done: "border-status-green/30 bg-status-green/10 text-status-green",
	muted: "border-border bg-surface-1 text-text-secondary",
};

const KIND_TONE: Record<RuntimePipelineCardStageKind, StageTone> = {
	settling: "muted",
	checks_queued: "waiting",
	checks_running: "active",
	qa_waiting_checks: "waiting",
	qa_next: "waiting",
	qa_queued: "waiting",
	qa_running: "active",
	qa_verdict: "attention",
	no_qa: "muted",
	rework_sent: "active",
	recovery: "attention",
	held: "waiting",
	escalated: "attention",
	stopped: "attention",
};

function getStageTone(stage: RuntimePipelineCardStage): StageTone {
	return stage.kind === "qa_verdict" && stage.label.endsWith(" PASS") ? "done" : KIND_TONE[stage.kind];
}

function getStageIcon(tone: StageTone, kind: RuntimePipelineCardStageKind): ReactNode {
	if (kind === "rework_sent") {
		return <RotateCcw size={12} className="shrink-0" />;
	}
	if (tone === "active") {
		return <Loader2 size={12} className="shrink-0 animate-spin motion-reduce:animate-none" />;
	}
	if (tone === "waiting") {
		return kind === "held" ? (
			<PauseCircle size={12} className="shrink-0" />
		) : (
			<Clock size={12} className="shrink-0" />
		);
	}
	if (tone === "attention") {
		return <AlertTriangle size={12} className="shrink-0" />;
	}
	if (tone === "done") {
		return <CheckCircle2 size={12} className="shrink-0" />;
	}
	return <Workflow size={12} className="shrink-0" />;
}

/** "07:03": a deadline today in the viewer's time zone, short enough for a phone. */
export function formatPipelineStageDeadline(deadline: number): string {
	return new Date(deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The stage in one line: "Checks running (test) · QA next · until 07:03". */
export function describePipelineCardStage(stage: RuntimePipelineCardStage): string {
	const parts = [stage.label];
	if (stage.qaTaskId && !stage.label.includes(stage.qaTaskId)) {
		parts[0] = `${stage.label} (${stage.qaTaskId})`;
	}
	if (stage.next) {
		parts.push(stage.next);
	}
	if (stage.deadline !== null) {
		parts.push(`until ${formatPipelineStageDeadline(stage.deadline)}`);
	}
	return parts.join(" · ");
}

/** The card's pipeline stage (landing mode qa), as the pipeline worker last reported it; nothing when it has none. */
export function BoardCardPipelineStage({ taskId }: { taskId: string }): ReactElement | null {
	const stage = usePipelineCardStage(taskId);
	if (!stage) {
		return null;
	}
	const tone = getStageTone(stage);
	const text = describePipelineCardStage(stage);
	const badge = (
		<span
			data-testid="board-card-pipeline-stage"
			data-stage-kind={stage.kind}
			className={cn(
				"mt-1.5 flex w-fit max-w-full min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
				TONE_CLASS[tone],
			)}
		>
			{getStageIcon(tone, stage.kind)}
			<span className="truncate">{text}</span>
		</span>
	);
	return stage.detail ? (
		<Tooltip side="bottom" content={stage.detail}>
			{badge}
		</Tooltip>
	) : (
		badge
	);
}
