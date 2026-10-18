import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { useKnowledgeQuery } from "@/hooks/use-knowledge-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { formatRunningDuration } from "../../../src/core/task-running-time";

const duration = (value: number | null) => (value === null ? "Unknown" : formatRunningDuration(value));
const money = (value: number | null) =>
	value === null
		? "Unknown"
		: value > 0 && value < 0.000001
			? "< $0.000001 (estimate)"
			: new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(
					value,
				);
export function EfficiencyDialog(props: { workspaceId: string; projectName: string; onClose: () => void }) {
	return <EfficiencyScope key={props.workspaceId} {...props} />;
}
function EfficiencyScope({
	workspaceId,
	projectName,
	onClose,
}: {
	workspaceId: string;
	projectName: string;
	onClose: () => void;
}) {
	const [scope, setScope] = useState("project"),
		[id, setId] = useState(""),
		[request, setRequest] = useState<{ taskId?: string; planTaskId?: string; objectiveId?: string }>({}),
		[generation, setGeneration] = useState(0);
	const queryFn = useCallback(
		() => getRuntimeTrpcClient(workspaceId).efficiency.report.query(request),
		[workspaceId, request],
	);
	const report = useKnowledgeQuery(JSON.stringify([workspaceId, request, generation]), queryFn),
		data = report.data;
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			contentClassName="max-w-3xl"
		>
			<DialogHeader title={`Efficiency · ${projectName}`} />
			<DialogBody className="space-y-3">
				<p className="text-sm text-text-secondary">
					Report only. Native running-counter deltas and sampled stage occupancy are observations, not QA
					acceptance, invoice totals, a billing cap or an automatic routing decision.
				</p>
				<form
					className="flex flex-wrap gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						setRequest(
							scope === "project"
								? {}
								: scope === "task"
									? { taskId: id.trim() }
									: scope === "plan"
										? { planTaskId: id.trim() }
										: { objectiveId: id.trim() },
						);
						setGeneration((value) => value + 1);
					}}
				>
					<NativeSelect
						aria-label="Efficiency scope"
						value={scope}
						onChange={(event) => setScope(event.currentTarget.value)}
					>
						<option value="project">Project</option>
						<option value="task">Task</option>
						<option value="plan">Plan family</option>
						<option value="objective">Objective family</option>
					</NativeSelect>
					{scope !== "project" ? (
						<input
							aria-label="Efficiency scope id"
							value={id}
							maxLength={160}
							onChange={(event) => setId(event.currentTarget.value)}
							className="min-w-0 flex-1 rounded-md border border-border-bright bg-surface-2 px-2"
						/>
					) : null}
					<Button type="submit" size="sm" disabled={scope !== "project" && !id.trim()}>
						Read efficiency report
					</Button>
				</form>
				{report.isError ? (
					<p role="alert" className="text-status-red">
						Report sources are unavailable or the selected id is not in this project. Unknown values were not
						converted to zero.
					</p>
				) : report.isLoading ? (
					<p>Reading retained observations…</p>
				) : data ? (
					<>
						<dl className="grid grid-cols-2 gap-2 text-sm">
							<dt>Scope / recorded tasks</dt>
							<dd>
								{data.scope} / {data.taskCount}
							</dd>
							<dt>Observed native agent running time</dt>
							<dd>{duration(data.observedAgentRunningMs)}</dd>
							<dt>Union of sampled stage windows</dt>
							<dd>{duration(data.observedElapsedMs)}</dd>
							<dt>Summed task/stage occupancy</dt>
							<dd>{duration(data.summedSampledMs)}</dd>
							<dt>Observed conservative spend subtotal</dt>
							<dd>{money(data.observedEstimatedUsd)}</dd>
							<dt>Total estimated cost</dt>
							<dd>Unknown</dd>
							<dt>Coverage</dt>
							<dd>Partial or unknown</dd>
							<dt>Completion forecast</dt>
							<dd>Insufficient evidence (forecast model not implemented)</dd>
						</dl>
						<p className="text-xs text-text-secondary">
							Overlapping stage/task windows are unioned for elapsed coverage, not counted as a critical-path
							completion time. Short transitions and restart gaps may be absent. Subscription/local capacity is
							not unlimited because a marginal estimate is zero.
						</p>
						<h3 className="text-sm font-semibold">Observed timing categories</h3>
						<ul className="space-y-1 text-sm">
							{data.timing.map((row) => (
								<li key={row.category}>
									{row.category.replaceAll("_", " ")}: {duration(row.sampledMs)} (sampled occupancy)
								</li>
							))}
						</ul>
						<h3 className="text-sm font-semibold">Attributed usage components</h3>
						{data.components.length ? (
							<ul className="space-y-2 text-sm">
								{data.components.map((row) => (
									<li key={row.kind}>
										{row.kind} · {row.tasks} task(s) · {money(row.observedEstimatedUsd)}
										{row.observedTokens
											? ` · observed input ${row.observedTokens.input}, output ${row.observedTokens.output}, cache read ${row.observedTokens.cacheRead}, cache write ${row.observedTokens.cacheWrite}`
											: " · token counts unknown"}
									</li>
								))}
							</ul>
						) : (
							<p className="text-sm text-text-secondary">
								No retained attributed usage observations. Unlinked work/overhead is unknown, not free.
							</p>
						)}
						<details>
							<summary className="cursor-pointer text-sm">Coverage and price provenance</summary>
							<ul className="space-y-1 text-xs text-text-secondary">
								{data.warnings.map((warning) => (
									<li key={warning}>{warning.replaceAll("_", " ")}</li>
								))}
							</ul>
							<p className="break-all text-xs">
								Price sources: {data.priceSources.join(", ") || "unknown"} · Charge kinds:{" "}
								{data.chargeKinds.join(", ") || "unknown"}. Price revisions:{" "}
								{data.priceRevisions.join(", ") || "unknown"}
							</p>
						</details>
					</>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button size="sm" onClick={() => setGeneration((value) => value + 1)}>
					Refresh observed report
				</Button>
				<Button size="sm" onClick={onClose}>
					Close efficiency
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
