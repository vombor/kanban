import { RefreshCw } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeProcessCardStatus, RuntimeProcessOrphan, RuntimeProcessSweepResponse } from "@/runtime/types";
import { useProcessSweep } from "@/runtime/use-process-sweep";

const MAX_LISTED_ROWS = 8;

const CARD_STATUS_CLASS: Record<RuntimeProcessCardStatus, string> = {
	active: "text-status-green",
	done: "text-status-red",
	missing: "text-status-orange",
	unknown: "text-text-tertiary",
};

const ORPHAN_ACTION_CLASS: Record<RuntimeProcessOrphan["action"], string> = {
	terminated: "text-status-green",
	killed: "text-status-orange",
	failed: "text-status-red",
	reported: "text-text-secondary",
	shared_daemon: "text-status-blue",
	shared: "text-status-blue",
};

function formatMegabytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function describeSettings(status: RuntimeProcessSweepResponse): string {
	if (!status.supported) {
		return "Process cleanup reads /proc and is off on this platform.";
	}
	const { enabled, intervalSec, mode } = status.settings;
	if (!enabled) {
		return "The periodic sweep is off (processes.reaper.enabled in config.json).";
	}
	const minutes = Math.round(intervalSec / 60);
	const every = minutes >= 1 ? `${minutes} min` : `${intervalSec} s`;
	return mode === "terminate"
		? `Every ${every}, orphans of finished cards are terminated.`
		: `Every ${every}, orphans are reported only (mode "report").`;
}

function SweepDetails({ status }: { status: RuntimeProcessSweepResponse }): ReactElement {
	const sweep = status.lastSweep;
	if (!sweep) {
		return <p className="mt-2 text-xs text-text-tertiary">No sweep has run yet.</p>;
	}
	return (
		<div className="mt-2 space-y-2 text-xs">
			<p className="text-text-secondary">
				Last sweep {new Date(sweep.finishedAt).toLocaleTimeString()}: {sweep.processCount} processes,{" "}
				{formatMegabytes(sweep.rssBytes)} in {sweep.cards.length} task worktrees.
			</p>
			{sweep.error ? <p className="text-status-red">Sweep failed: {sweep.error}</p> : null}
			{sweep.cards.length > 0 ? (
				<ul className="space-y-0.5">
					{sweep.cards.slice(0, MAX_LISTED_ROWS).map((card) => (
						<li key={card.taskId} className="flex gap-2 font-mono">
							<span className="text-text-primary">{card.taskId}</span>
							<span className={CARD_STATUS_CLASS[card.status]}>{card.status}</span>
							<span className="ml-auto text-text-secondary">
								{card.processCount} proc · {formatMegabytes(card.rssBytes)}
							</span>
						</li>
					))}
				</ul>
			) : null}
			{sweep.orphans.length > 0 ? (
				<div>
					<p className="font-medium text-text-primary">Orphans</p>
					<ul className="space-y-0.5">
						{sweep.orphans.slice(0, MAX_LISTED_ROWS).map((orphan) => (
							<li
								key={orphan.pid}
								className="flex gap-2 font-mono"
								title={[orphan.cwd, orphan.detail ?? orphan.error].filter(Boolean).join("\n") || undefined}
							>
								<span className={ORPHAN_ACTION_CLASS[orphan.action]}>
									{orphan.action === "reported" && orphan.eligible ? "would end" : orphan.action}
								</span>
								<span className="text-text-secondary">
									{orphan.pid} {orphan.taskId}
								</span>
								<span className="truncate text-text-primary">{orphan.command}</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
			{sweep.zombies.length > 0 ? (
				<div>
					<p className="font-medium text-text-primary">Zombies (only their parent can reap them)</p>
					<ul className="space-y-0.5">
						{sweep.zombies.slice(0, MAX_LISTED_ROWS).map((zombie) => (
							<li key={zombie.pid} className="flex gap-2 font-mono">
								<span className="text-text-secondary">
									{zombie.pid} ← {zombie.ppid}
								</span>
								<span className="truncate text-text-primary">
									{zombie.command} (parent: {zombie.parentCommand ?? "?"})
								</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}

/** Processes running in task worktrees, from the runtime's orphan sweep. */
export function ProcessSweepPanel({ open }: { open: boolean }): ReactElement {
	const { status, isLoading, error, isSweeping, sweepNow } = useProcessSweep(open);
	return (
		<div className="rounded-md border border-border bg-surface-2 p-3">
			<p className="text-sm font-medium text-text-primary">Task processes</p>
			<p className={cn("mt-1 text-xs", status?.supported === false ? "text-text-tertiary" : "text-text-secondary")}>
				{status ? describeSettings(status) : isLoading ? "Loading..." : "Process sweep status is unavailable."}
			</p>
			{error ? <p className="mt-1 text-xs text-status-red">{error.message}</p> : null}
			{status?.supported ? <SweepDetails status={status} /> : null}
			{status?.supported ? (
				<Button
					variant="default"
					size="sm"
					icon={isSweeping ? <Spinner size={12} /> : <RefreshCw size={14} />}
					disabled={isSweeping}
					onClick={() => void sweepNow()}
					className="mt-3"
				>
					{isSweeping ? "Sweeping..." : "Sweep now"}
				</Button>
			) : null}
		</div>
	);
}
