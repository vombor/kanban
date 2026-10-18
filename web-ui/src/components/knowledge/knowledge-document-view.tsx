import { useCallback, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useKnowledgeQuery } from "@/hooks/use-knowledge-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { KnowledgeDocument } from "../../../../src/trpc/knowledge-contract";
import { KnowledgeCurationAction } from "./knowledge-curation-action";
import { KnowledgeMarkdown } from "./knowledge-markdown";
import { KnowledgeProvenance } from "./knowledge-provenance";

export function KnowledgeDocumentView({
	workspaceId,
	document,
	canPin,
	onChanged,
}: {
	workspaceId: string;
	document: KnowledgeDocument;
	canPin: boolean;
	onChanged: () => void;
}) {
	const sectionId = useId();
	const [revision, setRevision] = useState(document.revision),
		[section, setSection] = useState<string | undefined>(),
		[offset, setOffset] = useState(0),
		[historyOffset, setHistoryOffset] = useState(0);
	const readFn = useCallback(
		() =>
			getRuntimeTrpcClient(workspaceId).knowledge.read.query({
				id: document.id,
				revision,
				section,
				offset,
				limit: 4096,
			}),
		[workspaceId, document.id, revision, section, offset],
	);
	const historyFn = useCallback(
		() =>
			getRuntimeTrpcClient(workspaceId).knowledge.history.query({
				id: document.id,
				offset: historyOffset,
				limit: 20,
			}),
		[workspaceId, document.id, historyOffset],
	);
	const read = useKnowledgeQuery(JSON.stringify([workspaceId, document.id, revision, section, offset]), readFn);
	const history = useKnowledgeQuery(JSON.stringify([workspaceId, document.id, historyOffset]), historyFn);
	const current = revision === document.revision;
	return (
		<article aria-label="Knowledge document" className="min-w-0 space-y-3">
			<h3 className="text-base font-semibold">{document.title}</h3>
			<p className="text-xs text-text-secondary">
				{current ? "Current published revision" : "Historical revision — not current"}. Reference material, not
				execution approval or task adoption.
			</p>
			{read.data ? <KnowledgeProvenance document={read.data.document} /> : null}
			{canPin && current && read.data ? (
				<KnowledgeCurationAction
					key={`${workspaceId}:${revision}`}
					workspaceId={workspaceId}
					action={{ action: "pin", id: document.id, pinned: !document.pinnedByUser, expectedRevision: revision }}
					label={document.pinnedByUser ? "Unpin decision" : "Pin decision"}
					onConfirmed={onChanged}
				/>
			) : null}
			<label htmlFor={sectionId} className="block text-xs text-text-secondary">
				Read section
				<NativeSelect
					id={sectionId}
					aria-label="Read section"
					value={section ?? ""}
					onChange={(event) => {
						setSection(event.currentTarget.value || undefined);
						setOffset(0);
					}}
				>
					<option value="">Whole document (bounded slices)</option>
					{read.data?.sections.map((item) => (
						<option key={item.id} value={item.id}>
							{item.title}
						</option>
					))}
				</NativeSelect>
			</label>
			{read.isLoading ? (
				<p role="status">Reading exact revision…</p>
			) : read.isError ? (
				<p role="alert" className="text-status-red">
					This revision could not be read. No current-version fallback was loaded.
				</p>
			) : read.data ? (
				<KnowledgeMarkdown markdown={read.data.markdown} />
			) : null}
			{read.data ? (
				<div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
					<span>
						Slice offset {read.data.offset}
						{read.data.truncated ? " · Truncated, not the complete document" : " · End of selected text"}
					</span>
					{offset ? (
						<Button size="sm" onClick={() => setOffset(0)}>
							First document slice
						</Button>
					) : null}
					{read.data.nextOffset !== null ? (
						<Button size="sm" onClick={() => setOffset(read.data?.nextOffset ?? 0)}>
							Next document slice
						</Button>
					) : null}
				</div>
			) : null}
			<details>
				<summary className="cursor-pointer text-sm text-text-secondary">Published revision history</summary>
				{history.isError ? (
					<p role="alert">Revision history unavailable.</p>
				) : (
					<div className="mt-2 space-y-2">
						{history.data?.revisions.map((item) => (
							<Button
								key={item.revision}
								size="sm"
								variant={revision === item.revision ? "primary" : "default"}
								className="h-auto w-full justify-start break-all text-left"
								onClick={() => {
									setRevision(item.revision);
									setSection(undefined);
									setOffset(0);
								}}
							>
								{item.revision.slice(0, 12)}
								{item.pinnedByUser ? " · user-pinned" : ""}
							</Button>
						))}
						<div className="flex gap-2">
							<Button
								size="sm"
								disabled={!historyOffset}
								onClick={() => setHistoryOffset(Math.max(0, historyOffset - 20))}
							>
								Previous revisions
							</Button>
							<Button
								size="sm"
								disabled={history.data?.nextOffset == null}
								onClick={() => setHistoryOffset(history.data?.nextOffset ?? 0)}
							>
								Next revisions
							</Button>
						</div>
					</div>
				)}
			</details>
		</article>
	);
}
