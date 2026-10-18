import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useIntegrationReport } from "@/hooks/use-integration-report";

export function IntegrationDialog(props: { workspaceId: string; onClose: () => void }) {
	return <IntegrationScope key={props.workspaceId} {...props} />;
}
function IntegrationScope({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
	const [ids, setIds] = useState(""),
		[plan, setPlan] = useState(""),
		[acknowledged, setAcknowledged] = useState(false);
	const view = useIntegrationReport(workspaceId);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			contentClassName="max-w-4xl"
		>
			<DialogHeader title="Speculative integration reports" />
			<DialogBody className="space-y-3">
				<p className="text-sm text-text-secondary">
					Preview is read-only. Explicit execution runs project code in a disposable candidate through the existing
					shared checks queue. It never resolves conflicts, starts agents, changes worktrees/branches, accepts QA
					or lands cards.
				</p>
				<p className="text-xs text-text-secondary">
					Project scripts run with the checker's process authority, not inside an OS security sandbox. Passing
					checks never grant QA acceptance or permission to land.
				</p>
				<form
					className="space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						setAcknowledged(false);
						void view.preview(ids.split(/[\s,]+/u).filter(Boolean), plan.trim() || undefined);
					}}
				>
					<input
						aria-label="Integration task ids"
						value={ids}
						maxLength={500}
						onChange={(event) => setIds(event.currentTarget.value)}
						placeholder="2–6 Review task ids, separated by commas"
						className="w-full rounded-md border border-border-bright bg-surface-2 px-2 py-1"
					/>
					<input
						aria-label="Integration approved plan id (optional)"
						value={plan}
						maxLength={80}
						onChange={(event) => setPlan(event.currentTarget.value)}
						placeholder="Optional approved plan id"
						className="w-full rounded-md border border-border-bright bg-surface-2 px-2 py-1"
					/>
					<Button type="submit" size="sm" disabled={view.busy || view.unresolved}>
						Preview exact candidate
					</Button>
				</form>
				{view.error ? (
					<p role="alert" className="text-sm text-status-orange">
						{view.error}
					</p>
				) : null}
				{view.manifest ? (
					<section className="space-y-2 text-sm">
						<p className="break-all">Base: {view.manifest.baseCommit}</p>
						<ul className="space-y-1 text-xs">
							{view.manifest.members.map((member) => (
								<li key={member.taskId} className="break-all">
									{member.taskId} @ {member.snapshot} · context {member.contextRevision ?? "unknown/unpinned"}
								</li>
							))}
						</ul>
						<p className="break-all text-xs">Candidate fingerprint: {view.manifest.fingerprint}</p>
						<p>
							Configured checks: {view.manifest.scripts.join(", ") || "none; no passing-check claim possible"}
						</p>
						<details>
							<summary className="cursor-pointer text-xs">Candidate evidence boundaries</summary>
							<ul className="text-xs text-text-secondary">
								{view.manifest.warnings.map((warning) => (
									<li key={warning}>{warning.replaceAll("_", " ")}</li>
								))}
							</ul>
							<p className="break-all text-xs">Checks fingerprint: {view.manifest.checksFingerprint}</p>
							<p className="break-all text-xs">Toolchain fingerprint: {view.manifest.toolchainFingerprint}</p>
						</details>
						{!view.requestId ? (
							<>
								<label className="flex items-start gap-2">
									<input
										type="checkbox"
										checked={acknowledged}
										onChange={(event) => setAcknowledged(event.currentTarget.checked)}
									/>
									<span>
										I explicitly authorize running this exact candidate's project install/setup/check/teardown
										code. This is not QA or landing approval.
									</span>
								</label>
								<Button
									size="sm"
									variant="primary"
									disabled={!acknowledged || view.busy}
									onClick={() => void view.run()}
								>
									Run exact candidate checks
								</Button>
							</>
						) : null}
					</section>
				) : null}
				{view.requestId ? (
					<p className="break-all text-xs">
						Retained request id: {view.requestId}. Closing or losing this page never authorizes replay.
					</p>
				) : null}
				{view.report ? (
					<section className="space-y-2 rounded-md border border-border p-2 text-sm">
						<p>
							Status: {view.report.status.replaceAll("_", " ")} · freshness: {view.report.freshness} · candidate
							cleanup: {view.report.cleanup.replaceAll("_", " ")}
						</p>
						{view.report.conflictTaskId ? (
							<p>Conflicts while combining {view.report.conflictTaskId}; no resolution was invented.</p>
						) : null}
						{view.report.reason ? <p>{view.report.reason.replaceAll("_", " ")}</p> : null}
						<p className="break-all text-xs">Candidate tree: {view.report.candidateTree ?? "unavailable"}</p>
						<ul>
							{view.report.steps.map((step, index) => (
								<li key={`${index}:${step.name}`}>
									{step.name}: {step.status}
									{step.advisory ? " (advisory cleanup step)" : ""}
									{step.harness ? " (harness; not a code verdict)" : ""}
								</li>
							))}
						</ul>
						<p>
							Even current passing checks apply only to this exact combination—not individual QA acceptance or
							permission to land.
						</p>
					</section>
				) : null}
				{view.requestId ? (
					<Button size="sm" disabled={view.busy} onClick={() => void view.read(view.requestId ?? "")}>
						Read retained report
					</Button>
				) : null}
				<h3 className="text-sm font-semibold">Recent retained reports</h3>
				{view.history.isError ? (
					<p role="alert">Integration history unavailable; it was not reset.</p>
				) : (
					<ul className="space-y-1">
						{view.history.data?.reports.map((report) => (
							<li key={report.id}>
								<Button
									size="sm"
									disabled={view.busy}
									onClick={() => void view.read(report.id)}
									className="h-auto break-all text-left"
								>
									{report.id} · {report.status.replaceAll("_", " ")}
								</Button>
							</li>
						))}
					</ul>
				)}
				<p className="text-xs text-text-secondary">
					Recent history is bounded to 20 entries here. Uncertain executions retain their reservation for operator
					review; they are never rerun automatically. Raw logs, environment values and credentials are not returned
					by this report.
				</p>
			</DialogBody>
			<DialogFooter>
				<Button size="sm" onClick={view.refresh}>
					Refresh report history
				</Button>
				<Button size="sm" onClick={onClose}>
					Close integration
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
