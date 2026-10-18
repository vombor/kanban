import { diffLines } from "diff";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useKnowledgeProposal } from "@/hooks/use-knowledge-proposal";
import { formatLocalTime } from "@/utils/format-local-time";
import { KnowledgeCurationAction } from "./knowledge-curation-action";
import { KnowledgeMarkdown } from "./knowledge-markdown";
import { KnowledgeSources } from "./knowledge-provenance";

export function KnowledgeProposalView({
	workspaceId,
	proposalId,
	canPublish,
	canPin,
	onChanged,
}: {
	workspaceId: string;
	proposalId: string;
	canPublish: boolean;
	canPin: boolean;
	onChanged: () => void;
}) {
	const [offset, setOffset] = useState(0);
	const query = useKnowledgeProposal(workspaceId, proposalId, offset),
		data = query.data;
	const differences = useMemo(() => (data ? diffLines(data.base?.markdown ?? "", data.markdown) : []), [data]);
	if (query.isError)
		return (
			<p role="alert" className="text-status-red">
				Proposal comparison could not be read completely at this slice. No publication is enabled.
			</p>
		);
	if (!data) return <p role="status">Reading proposal, base and current revision…</p>;
	const proposal = data.proposal,
		currentRevision = data.current?.document.revision ?? null;
	const stale = currentRevision !== proposal.baseRevision;
	const permitted = canPublish && (!data.current?.document.pinnedByUser || canPin);
	const continuations = [data.nextOffset, data.base?.nextOffset, data.current?.nextOffset].filter(
		(value): value is number => value !== null && value !== undefined,
	);
	const nextOffset = continuations.length ? Math.min(...continuations) : null;
	return (
		<article aria-label="Knowledge proposal" className="min-w-0 space-y-3">
			<h3 className="text-base font-semibold">{proposal.document.title}</h3>
			<p className="break-all text-xs text-text-secondary">
				Proposal {proposal.id} · {proposal.status} · {proposal.document.id}
			</p>
			<p className="text-sm">Reason: {proposal.reason}</p>
			<p className="text-xs text-text-secondary">
				{proposal.document.kind} · {proposal.document.summary}
				{proposal.document.tags.length ? ` · Tags: ${proposal.document.tags.join(", ")}` : ""}
			</p>
			<p className="break-all text-xs text-text-secondary">
				Submitted by{" "}
				{proposal.submittedBy.kind === "user"
					? "user"
					: `${proposal.submittedBy.role} (${proposal.submittedBy.taskId})`}
				. Base {proposal.baseRevision ?? "new document"}; current {currentRevision ?? "no published document"}.
			</p>
			<KnowledgeSources sources={proposal.document.sources} />
			<p className="text-xs text-text-secondary">
				Submitted{" "}
				{Number.isFinite(Date.parse(proposal.submittedAt))
					? formatLocalTime(Date.parse(proposal.submittedAt))
					: "time unknown"}
				{proposal.reviewedAt && Number.isFinite(Date.parse(proposal.reviewedAt))
					? ` · Reviewed ${formatLocalTime(Date.parse(proposal.reviewedAt))} by ${proposal.reviewedBy?.kind === "user" ? "user" : (proposal.reviewedBy?.role ?? "unknown")}`
					: ""}
			</p>
			{stale ? (
				<p className="text-status-orange">
					Stale proposal: publication is disabled. Resubmit against the current revision; no silent rebase.
				</p>
			) : null}
			<p className="text-xs text-text-secondary">
				Bounded comparison at offset {offset}, not necessarily the whole proposal. Publication curates reference
				material only; it never approves a plan or adopts task references.
			</p>
			<KnowledgeMarkdown markdown={data.markdown} />
			<details>
				<summary className="cursor-pointer text-sm text-text-secondary">
					Compare proposal with its exact base
				</summary>
				<pre
					aria-label="Proposal slice diff"
					role="region"
					className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-0 p-2 text-xs"
				>
					{differences.map((part, index) => (
						<span
							key={`${index}:${part.added}:${part.removed}`}
							className={cn(part.added && "text-status-green", part.removed && "text-status-red")}
						>
							{part.added ? "+ " : part.removed ? "− " : "  "}
							{part.value}
						</span>
					))}
				</pre>
				<p className="mt-2 text-xs text-text-secondary">Base metadata (or no prior document):</p>
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
					{JSON.stringify(
						data.base
							? {
									title: data.base.document.title,
									kind: data.base.document.kind,
									summary: data.base.document.summary,
									tags: data.base.document.tags,
									sources: data.base.document.sources,
								}
							: null,
						null,
						2,
					)}
				</pre>
			</details>
			{stale && data.current ? (
				<details>
					<summary className="cursor-pointer text-sm text-text-secondary">Current published slice</summary>
					<KnowledgeMarkdown markdown={data.current.markdown} />
				</details>
			) : null}
			<div className="flex flex-wrap gap-2">
				{offset ? (
					<Button size="sm" onClick={() => setOffset(0)}>
						First proposal slice
					</Button>
				) : null}
				{nextOffset !== null ? (
					<Button size="sm" onClick={() => setOffset(nextOffset)}>
						Next proposal slice
					</Button>
				) : null}
			</div>
			{proposal.status === "pending" && permitted ? (
				<div className="space-y-2">
					{!stale ? (
						<KnowledgeCurationAction
							key={`publish:${proposal.id}:${currentRevision}`}
							workspaceId={workspaceId}
							action={{
								action: "review",
								proposalId: proposal.id,
								decision: "publish",
								expectedRevision: currentRevision,
							}}
							label="Publish proposal"
							onConfirmed={onChanged}
						/>
					) : null}
					<KnowledgeCurationAction
						key={`reject:${proposal.id}:${currentRevision}`}
						workspaceId={workspaceId}
						action={{
							action: "review",
							proposalId: proposal.id,
							decision: "reject",
							expectedRevision: currentRevision,
						}}
						label="Reject proposal"
						onConfirmed={onChanged}
					/>
				</div>
			) : null}
		</article>
	);
}
