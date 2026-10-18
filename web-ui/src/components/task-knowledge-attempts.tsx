import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useKnowledgeQuery } from "@/hooks/use-knowledge-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { formatLocalTime } from "@/utils/format-local-time";

export function TaskKnowledgeAttempts({
	workspaceId,
	taskId,
	onRead,
}: {
	workspaceId: string | null;
	taskId: string;
	onRead: (id: string) => void;
}) {
	const [open, setOpen] = useState(false),
		[offset, setOffset] = useState(0);
	const queryFn = useCallback(
		() => getRuntimeTrpcClient(workspaceId).taskKnowledge.attempts.query({ taskId, offset, limit: 10 }),
		[workspaceId, taskId, offset],
	);
	const query = useKnowledgeQuery(
		JSON.stringify([workspaceId, taskId, offset]),
		queryFn,
		open && Boolean(workspaceId),
	);
	return (
		<section className="space-y-2">
			<Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
				{open ? "Hide retained attempts" : "Inspect retained attempts"}
			</Button>
			{open ? (
				<>
					<p className="text-xs text-text-secondary">
						Physical-start outcomes and prepared rework reference handoffs. A reservation, queued input or
						uncertain outcome is not proof of execution, QA or acceptance.
					</p>
					{query.isError ? (
						<p role="alert" className="text-status-red">
							Retained attempt context could not be verified; no mutable fallback was used.
						</p>
					) : query.isLoading ? (
						<p>Reading retained attempts…</p>
					) : query.data?.attempts.length === 0 ? (
						<p className="text-xs text-text-secondary">No attempt history recorded for this task.</p>
					) : null}
					{query.data?.attempts.map((attempt) => (
						<div key={attempt.id} className="space-y-1 rounded-md border border-border p-2 text-xs">
							<p>
								{attempt.kind === "session" ? "Physical session" : "Prepared rework handoff"} ·{" "}
								{attempt.outcome} · {formatLocalTime(Date.parse(attempt.reservedAt))}
							</p>
							<p className="break-all">
								Attempt {attempt.id}
								<br />
								Context {attempt.contextRevision}
								{attempt.snapshot ? (
									<>
										<br />
										Requested snapshot {attempt.snapshot}
									</>
								) : null}
							</p>
							<Button size="sm" onClick={() => onRead(attempt.id)}>
								Read attempt spec
							</Button>
						</div>
					))}
					<div className="flex gap-2">
						<Button
							size="sm"
							disabled={!offset || query.isLoading}
							onClick={() => setOffset(Math.max(0, offset - 10))}
						>
							Previous attempts
						</Button>
						<Button
							size="sm"
							disabled={query.data?.nextOffset == null || query.isLoading}
							onClick={() => setOffset(query.data?.nextOffset ?? 0)}
						>
							Next attempts
						</Button>
					</div>
				</>
			) : null}
		</section>
	);
}
