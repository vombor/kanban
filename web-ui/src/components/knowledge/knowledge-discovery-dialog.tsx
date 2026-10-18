import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useKnowledgeQuery } from "@/hooks/use-knowledge-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { DiscoveryPointer } from "../../../../src/trpc/knowledge-discovery-contract";
import { DiscoveryPolicyPanel } from "./discovery-policy-panel";
import { KnowledgeMarkdown } from "./knowledge-markdown";

export function KnowledgeDiscoveryDialog(props: { workspaceId: string; onClose: () => void }) {
	return <DiscoveryScope key={props.workspaceId} {...props} />;
}
function DiscoveryScope({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
	const [query, setQuery] = useState(""),
		[draft, setDraft] = useState(""),
		[offset, setOffset] = useState(0),
		[generation, setGeneration] = useState(0),
		[selected, setSelected] = useState<DiscoveryPointer | null>(null),
		[readOffset, setReadOffset] = useState(0),
		[graphOpen, setGraphOpen] = useState(false),
		[configOpen, setConfigOpen] = useState(false);
	const queryFn = useCallback(
		() => getRuntimeTrpcClient(workspaceId).knowledgeDiscovery.query.query({ query, offset, limit: 10 }),
		[workspaceId, query, offset],
	);
	const listing = useKnowledgeQuery(JSON.stringify([workspaceId, query, offset, generation]), queryFn);
	const readFn = useCallback(async () => {
		if (!selected) throw new Error("Choose a source");
		return getRuntimeTrpcClient(workspaceId).knowledgeDiscovery.read.query({
			...selected,
			offset: readOffset,
			limit: 4096,
		});
	}, [workspaceId, selected, readOffset]);
	const read = useKnowledgeQuery(
		JSON.stringify([workspaceId, selected, readOffset, generation]),
		readFn,
		Boolean(selected),
	);
	const graphFn = useCallback(async () => {
		if (!selected) throw new Error("Choose a source");
		return getRuntimeTrpcClient(workspaceId).knowledgeDiscovery.graph.query({ ...selected, depth: 2 });
	}, [workspaceId, selected]);
	const graph = useKnowledgeQuery(
		JSON.stringify([workspaceId, selected, generation]),
		graphFn,
		Boolean(selected) && graphOpen,
	);
	const reload = useCallback(() => {
		setGeneration((value) => value + 1);
		setSelected(null);
		setGraphOpen(false);
	}, []);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			contentClassName="max-w-5xl"
		>
			<DialogHeader title="Project and Shared reference sources" />
			<DialogBody className="space-y-3">
				<p className="text-sm text-text-secondary">
					Markdown-first, read-only discovery. Obsidian is optional. Results are mutable reference material, not
					publication, task pins or execution approval. Current attempts remain independent of these files.
				</p>
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						setQuery(draft.trim());
						setOffset(0);
						setSelected(null);
					}}
				>
					<input
						aria-label="Search reference sources"
						className="min-w-0 flex-1 rounded-md border border-border-bright bg-surface-2 px-2"
						value={draft}
						maxLength={200}
						onChange={(event) => setDraft(event.currentTarget.value)}
					/>
					<Button type="submit" size="sm">
						Search sources
					</Button>
				</form>
				{listing.data?.warnings.map((warning) => (
					<p key={warning} className="text-xs text-status-orange">
						{warning.replaceAll("_", " ")}
					</p>
				))}
				{listing.isError ? (
					<p role="alert" className="text-status-red">
						Scoped discovery unavailable. No private-project or mutable execution fallback was used.
					</p>
				) : null}
				<div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
					<aside className="min-w-0 space-y-2">
						{listing.isLoading ? <p>Discovering bounded references…</p> : null}
						{listing.data?.notes.map((note) => (
							<Button
								key={`${note.collection}:${note.path}`}
								size="sm"
								className="h-auto w-full justify-start whitespace-normal break-all text-left"
								onClick={() => {
									setSelected({ collection: note.collection, path: note.path, revision: note.revision });
									setReadOffset(0);
									setGraphOpen(false);
								}}
							>
								<span>
									<span className="block">{note.title}</span>
									<span className="block text-xs opacity-75">
										{note.collection} · {note.path}
									</span>
								</span>
							</Button>
						))}
						{listing.data ? (
							<p className="text-xs text-text-secondary">
								{listing.data.total} scoped references
								{listing.data.truncated ? " · Budget truncated; not a complete graph/index" : ""}
							</p>
						) : null}
						<div className="flex gap-2">
							<Button
								size="sm"
								disabled={!offset || listing.isLoading}
								onClick={() => {
									setOffset(Math.max(0, offset - 10));
									setSelected(null);
								}}
							>
								Previous sources
							</Button>
							<Button
								size="sm"
								disabled={listing.data?.nextOffset == null || listing.isLoading}
								onClick={() => {
									setOffset(listing.data?.nextOffset ?? 0);
									setSelected(null);
								}}
							>
								Next sources
							</Button>
						</div>
					</aside>
					<section className="min-w-0 space-y-2">
						{selected ? (
							<>
								<p className="break-all text-xs text-text-secondary">
									{selected.collection}/{selected.path} @ {selected.revision}
								</p>
								{read.isError ? (
									<p role="alert" className="text-status-red">
										Source changed, access was revoked, or the optional source is unavailable. Rediscover it
										explicitly; no different content was substituted.
									</p>
								) : read.data ? (
									<KnowledgeMarkdown markdown={read.data.markdown} />
								) : (
									<p>Reading exact source revision…</p>
								)}
								{read.data?.nextOffset != null ? (
									<Button size="sm" onClick={() => setReadOffset(read.data?.nextOffset ?? 0)}>
										Next source slice
									</Button>
								) : null}
								<Button size="sm" onClick={() => setGraphOpen((value) => !value)}>
									Inspect scoped links and tags
								</Button>
								{graphOpen ? (
									graph.isError ? (
										<p role="alert">Scoped graph unavailable or stale.</p>
									) : graph.data ? (
										<div className="space-y-1 text-xs">
											<p>
												{graph.data.nodes.length} permitted nodes
												{graph.data.truncated ? " · truncated" : ""}. Unknown indexing completeness is not
												readiness.
											</p>
											{graph.data.edges.map((edge, index) => (
												<p key={`${index}:${edge.from.path}:${edge.to.path}`} className="break-all">
													{edge.from.collection}/{edge.from.path} → {edge.to.collection}/{edge.to.path}
												</p>
											))}
											<p>
												Scoped tags:{" "}
												{graph.data.tags.map((item) => `${item.tag} (${item.count})`).join(", ") ||
													"none observed"}
											</p>
										</div>
									) : (
										<p>Reading scoped graph…</p>
									)
								) : null}
							</>
						) : (
							<p className="text-sm text-text-tertiary">
								Choose an explicitly permitted source. Shared folders require user opt-in; links never grant
								another project's private access.
							</p>
						)}
					</section>
				</div>
				<Button size="sm" variant="ghost" onClick={() => setConfigOpen((value) => !value)}>
					User-owned source configuration
				</Button>
				{configOpen ? <DiscoveryPolicyPanel workspaceId={workspaceId} onChanged={reload} /> : null}
			</DialogBody>
			<DialogFooter>
				<Button size="sm" onClick={reload}>
					Rediscover references
				</Button>
				<Button size="sm" onClick={onClose}>
					Close sources
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
