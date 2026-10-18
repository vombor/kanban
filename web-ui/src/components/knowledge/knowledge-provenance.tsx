import { formatLocalTime } from "@/utils/format-local-time";
import type { KnowledgeDocument, KnowledgeMetadata } from "../../../../src/trpc/knowledge-contract";
import { safeKnowledgeUrl } from "./knowledge-markdown";

export function KnowledgeSources({ sources }: { sources: KnowledgeMetadata["sources"] }) {
	return sources.length ? (
		<ul aria-label="Knowledge sources" className="space-y-1 break-all text-xs text-text-secondary">
			{sources.map((source, index) => (
				<li key={`${index}:${source.kind}`}>
					{source.kind === "url"
						? (() => {
								const url = safeKnowledgeUrl(source.url);
								return url ? (
									<a href={url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
										{url}
									</a>
								) : (
									<span>URL source (navigation disabled)</span>
								);
							})()
						: source.kind === "task"
							? `Task ${source.taskId}`
							: source.kind === "document"
								? `Document ${source.id} @ ${source.revision}`
								: `Repository ${source.path}${source.commit ? ` @ ${source.commit}` : ""}`}
				</li>
			))}
		</ul>
	) : null;
}
export function KnowledgeProvenance({ document }: { document: KnowledgeDocument }) {
	return (
		<div className="space-y-1 break-all text-xs text-text-secondary">
			<p>
				{document.kind} · {document.id}
				{document.pinnedByUser ? " · User-pinned decision" : ""}
			</p>
			<p>Revision {document.revision}</p>
			<p>Content SHA-256 {document.contentHash}</p>
			<p>
				Published{" "}
				{Number.isFinite(Date.parse(document.publishedAt))
					? formatLocalTime(Date.parse(document.publishedAt))
					: "time unknown"}{" "}
				by{" "}
				{document.publishedBy.kind === "user"
					? "user"
					: `${document.publishedBy.role} (${document.publishedBy.taskId})`}
			</p>
			{document.tags.length ? <p>Tags: {document.tags.join(", ")}</p> : null}
			<KnowledgeSources sources={document.sources} />
		</div>
	);
}
