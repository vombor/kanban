import { BookOpen, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import { CoordinationDialog } from "@/components/coordination-dialog";
import { EfficiencyDialog } from "@/components/efficiency-dialog";
import { IntegrationDialog } from "@/components/integration-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { useKnowledgeBrowser } from "@/hooks/use-knowledge-browser";
import type { KnowledgeDocument, KnowledgeProposal } from "../../../../src/trpc/knowledge-contract";
import { KnowledgeDiscoveryDialog } from "./knowledge-discovery-dialog";
import { KnowledgeDocumentView } from "./knowledge-document-view";
import { KnowledgeProposalView } from "./knowledge-proposal-view";

export function ProjectKnowledgeDialog(props: { workspaceId: string; projectName: string; onClose: () => void }) {
	// The scope key also protects standalone reuse: private state and pending mutations never retarget another project.
	return <KnowledgeDialogScope key={props.workspaceId} {...props} />;
}
function KnowledgeDialogScope({
	workspaceId,
	projectName,
	onClose,
}: {
	workspaceId: string;
	projectName: string;
	onClose: () => void;
}) {
	const kindId = useId(),
		statusId = useId();
	const [discoveryOpen, setDiscoveryOpen] = useState(false);
	const [efficiencyOpen, setEfficiencyOpen] = useState(false);
	const [coordinationOpen, setCoordinationOpen] = useState(false);
	const [integrationOpen, setIntegrationOpen] = useState(false);
	const view = useKnowledgeBrowser(workspaceId),
		[draft, setDraft] = useState("");
	const data = view.query.data,
		permissions = view.permissions.data;
	const selected = data?.documents.find((item) => item.id === view.selectedId);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			contentClassName="max-w-5xl"
			contentAriaDescribedBy="knowledge-scope-description"
		>
			<DialogHeader title={`Knowledge · ${projectName}`} icon={<BookOpen size={16} />} />
			<DialogBody className="space-y-3">
				<p id="knowledge-scope-description" className="text-sm text-text-secondary">
					Versioned reference material for this project. Publication and user pins never approve execution or
					silently adopt revisions into tasks. Obsidian connection settings are separate.
				</p>
				<div className="flex gap-2">
					<Button
						size="sm"
						variant={view.tab === "documents" ? "primary" : "default"}
						aria-pressed={view.tab === "documents"}
						onClick={() => view.setTab("documents")}
					>
						Documents
					</Button>
					<Button
						size="sm"
						variant={view.tab === "proposals" ? "primary" : "default"}
						aria-pressed={view.tab === "proposals"}
						onClick={() => view.setTab("proposals")}
					>
						Proposals
					</Button>
				</div>
				{view.tab === "documents" ? (
					<form
						className="flex flex-wrap items-end gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							if (!draft.trim() || draft.trim().length >= 2) view.search(draft.trim());
						}}
					>
						<label className="min-w-0 flex-1 text-xs text-text-secondary">
							Search knowledge
							<input
								aria-label="Search knowledge"
								value={draft}
								maxLength={200}
								onChange={(event) => setDraft(event.currentTarget.value)}
								className="mt-1 h-8 w-full rounded-md border border-border-bright bg-surface-2 px-2 text-text-primary"
							/>
						</label>
						<Button size="sm" type="submit" disabled={Boolean(draft.trim() && draft.trim().length < 2)}>
							Search
						</Button>
						<label htmlFor={kindId} className="text-xs text-text-secondary">
							Document kind
							<NativeSelect
								aria-label="Document kind"
								id={kindId}
								value={view.kind ?? ""}
								onChange={(event) =>
									view.setKind(
										(event.currentTarget.value || undefined) as KnowledgeDocument["kind"] | undefined,
									)
								}
							>
								<option value="">All kinds</option>
								{["overview", "plan", "contract", "decision", "discovery", "runbook"].map((kind) => (
									<option key={kind} value={kind}>
										{kind}
									</option>
								))}
							</NativeSelect>
						</label>
					</form>
				) : (
					<label htmlFor={statusId} className="block text-xs text-text-secondary">
						Proposal status
						<NativeSelect
							aria-label="Proposal status"
							id={statusId}
							value={view.status}
							onChange={(event) => view.setStatus(event.currentTarget.value as KnowledgeProposal["status"])}
						>
							{["pending", "published", "rejected"].map((status) => (
								<option key={status} value={status}>
									{status}
								</option>
							))}
						</NativeSelect>
					</label>
				)}
				{view.notice ? (
					<p role="status" className="text-xs text-status-green">
						{view.notice}
					</p>
				) : null}
				{view.query.isError || view.permissions.isError ? (
					<p role="alert" className="text-status-red">
						This project's knowledge or permissions could not be loaded. No foreign-project or mutable-file
						fallback is used.
					</p>
				) : null}
				<div className="grid min-h-64 gap-4 md:grid-cols-[minmax(180px,1fr)_minmax(0,2fr)]">
					<aside aria-label="Project knowledge list" className="min-w-0 space-y-2">
						{view.query.isLoading ? (
							<p role="status">Loading project pointers…</p>
						) : data && !data.documents.length && !data.proposals.length ? (
							<p className="text-sm text-text-secondary">
								No {view.tab === "documents" ? "matching documents" : `${view.status} proposals`} in this
								project.
							</p>
						) : null}
						{data?.documents.map((document) => (
							<Button
								key={document.id}
								size="sm"
								variant={document.id === view.selectedId ? "primary" : "default"}
								className="h-auto w-full justify-start whitespace-normal break-words text-left"
								onClick={() => view.select(document.id)}
							>
								<span className="min-w-0">
									<span className="block">{document.title}</span>
									<span className="block text-xs opacity-75">
										{document.kind} · {document.id}
										{document.pinnedByUser ? " · User-pinned" : ""}
									</span>
									{data.snippets[document.id] ? (
										<span className="block text-xs opacity-75">{data.snippets[document.id]}</span>
									) : null}
								</span>
							</Button>
						))}
						{data?.proposals.map((proposal) => (
							<Button
								key={proposal.id}
								size="sm"
								variant={proposal.id === view.selectedId ? "primary" : "default"}
								className="h-auto w-full justify-start whitespace-normal break-words text-left"
								onClick={() => view.select(proposal.id)}
							>
								<span>
									<span className="block">{proposal.document.title}</span>
									<span className="block text-xs opacity-75">
										{proposal.document.id} · {proposal.status}
									</span>
								</span>
							</Button>
						))}
						{data ? (
							<p className="text-xs text-text-secondary">
								{data.total} {view.tab}
								{data.truncated ? " · Search truncated: narrow the query or use document list pagination" : ""}
							</p>
						) : null}
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								disabled={!view.offset || view.query.isLoading}
								onClick={() => view.page(Math.max(0, view.offset - (view.tab === "proposals" ? 10 : 20)))}
							>
								Previous results
							</Button>
							<Button
								size="sm"
								disabled={data?.nextOffset == null || view.query.isLoading}
								onClick={() => view.page(data?.nextOffset ?? 0)}
							>
								Next results
							</Button>
						</div>
					</aside>
					<div className="min-w-0">
						{view.tab === "documents" && selected ? (
							<KnowledgeDocumentView
								key={`${workspaceId}:${selected.id}:${selected.revision}`}
								workspaceId={workspaceId}
								document={selected}
								canPin={permissions?.canPin ?? false}
								onChanged={view.changed}
							/>
						) : view.tab === "proposals" &&
							view.selectedId &&
							data?.proposals.some((item) => item.id === view.selectedId) ? (
							<KnowledgeProposalView
								key={`${workspaceId}:${view.selectedId}`}
								workspaceId={workspaceId}
								proposalId={view.selectedId}
								canPin={permissions?.canPin ?? false}
								canPublish={permissions?.canPublish ?? false}
								onChanged={view.changed}
							/>
						) : (
							<p className="text-sm text-text-tertiary">
								Select a pointer to read bounded content and provenance. Historical versions and proposals are
								never presented as execution approval.
							</p>
						)}
					</div>
				</div>
			</DialogBody>
			<DialogFooter>
				<div className="flex flex-wrap justify-end gap-2">
					<Button size="sm" onClick={() => setDiscoveryOpen(true)}>
						Explore reference sources
					</Button>
					<Button size="sm" onClick={() => setEfficiencyOpen(true)}>
						Efficiency reports
					</Button>
					<Button size="sm" onClick={() => setCoordinationOpen(true)}>
						Coordination preview
					</Button>
					<Button size="sm" onClick={() => setIntegrationOpen(true)}>
						Integration reports
					</Button>
					<Button size="sm" icon={<RefreshCw size={14} />} onClick={view.reload}>
						Reload knowledge
					</Button>
					<Button size="sm" onClick={onClose}>
						Close
					</Button>
				</div>
			</DialogFooter>
			{discoveryOpen ? (
				<KnowledgeDiscoveryDialog workspaceId={workspaceId} onClose={() => setDiscoveryOpen(false)} />
			) : null}
			{efficiencyOpen ? (
				<EfficiencyDialog
					workspaceId={workspaceId}
					projectName={projectName}
					onClose={() => setEfficiencyOpen(false)}
				/>
			) : null}
			{coordinationOpen ? (
				<CoordinationDialog workspaceId={workspaceId} onClose={() => setCoordinationOpen(false)} />
			) : null}
			{integrationOpen ? (
				<IntegrationDialog workspaceId={workspaceId} onClose={() => setIntegrationOpen(false)} />
			) : null}
		</Dialog>
	);
}
