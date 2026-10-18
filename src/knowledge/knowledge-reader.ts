import type { RuntimeKnowledgeApi } from "../trpc/knowledge-contract";
import { KnowledgeError } from "./knowledge-error";
import { describeKnowledgeRevision, findKnowledgeRevision } from "./knowledge-revisions";
import type { KnowledgeManifest, KnowledgeStoredRevision } from "./knowledge-schema";
import type { ProjectKnowledgeStore } from "./knowledge-store";
import { describeKnowledgeMarkdown, sliceKnowledgeText } from "./markdown";

function currentDocuments(manifest: KnowledgeManifest): KnowledgeStoredRevision[] {
	return Object.values(manifest.documents).flatMap((items) => items.at(-1) ?? []);
}
function page<T>(items: T[], offset: number, limit: number) {
	return {
		items: items.slice(offset, offset + limit),
		total: items.length,
		nextOffset: offset + limit < items.length ? offset + limit : null,
	};
}
type KnowledgeReads = Omit<RuntimeKnowledgeApi, "mutate" | "permissions">;
type ReadInput<K extends keyof KnowledgeReads> = Parameters<KnowledgeReads[K]> extends [unknown, unknown, infer Input]
	? Input
	: undefined;
/** Queries operate on one immutable manifest snapshot; search/indexing never issues a model turn. */
export function createKnowledgeReader(store: ProjectKnowledgeStore): {
	[K in keyof KnowledgeReads]: (workspaceId: string, input: ReadInput<K>) => ReturnType<KnowledgeReads[K]>;
} {
	return {
		list: async (workspaceId, input) => {
			const items = currentDocuments(await store.snapshot(workspaceId))
				.filter((item) => !input.kind || item.document.kind === input.kind)
				.sort(
					(a, b) => Number(b.pinnedByUser) - Number(a.pinnedByUser) || a.document.id.localeCompare(b.document.id),
				);
			const result = page(items, input.offset, input.limit);
			return {
				documents: result.items.map(describeKnowledgeRevision),
				total: result.total,
				nextOffset: result.nextOffset,
			};
		},
		read: async (workspaceId, input) => {
			const revision = findKnowledgeRevision(await store.snapshot(workspaceId), input.id, input.revision);
			const markdown = await store.readContent(workspaceId, revision.contentHash);
			const section = input.section ? revision.sections.find((candidate) => candidate.id === input.section) : null;
			if (input.section && !section)
				throw new KnowledgeError("NOT_FOUND", "That section is not in the selected document revision.");
			if (section && (section.start > section.end || section.end > markdown.length))
				throw new KnowledgeError("PRECONDITION_FAILED", "The stored section map is damaged.");
			return {
				document: describeKnowledgeRevision(revision),
				sections: revision.sections,
				...sliceKnowledgeText(
					section ? markdown.slice(section.start, section.end) : markdown,
					input.offset,
					input.limit,
				),
				authority: "reference_material_not_execution_approval",
			};
		},
		search: async (workspaceId, input) => {
			const manifest = await store.snapshot(workspaceId);
			const terms = [...new Set(input.query.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean))];
			const results = [];
			for (const revision of currentDocuments(manifest)) {
				if (input.kind && revision.document.kind !== input.kind) continue;
				const markdown = await store.readContent(workspaceId, revision.contentHash);
				const text = describeKnowledgeMarkdown(markdown).text;
				const lower = text.normalize("NFKC").toLowerCase();
				const metadata =
					`${revision.document.title} ${revision.document.summary} ${revision.document.tags.join(" ")}`
						.normalize("NFKC")
						.toLowerCase();
				if (!terms.every((term) => lower.includes(term) || metadata.includes(term))) continue;
				const score = terms.reduce(
					(sum, term) => sum + (metadata.includes(term) ? 3 : 0) + (lower.includes(term) ? 1 : 0),
					0,
				);
				const position = Math.max(0, lower.indexOf(terms[0] ?? ""));
				const snippet = text.slice(Math.max(0, position - 60), Math.max(0, position - 60) + 280);
				const section =
					revision.sections.find((candidate) => terms.some((term) => candidate.title.toLowerCase().includes(term)))
						?.id ?? null;
				results.push({ document: describeKnowledgeRevision(revision), snippet, section, score });
			}
			results.sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id));
			return {
				results: results.slice(0, input.limit),
				total: results.length,
				truncated: results.length > input.limit,
			};
		},
		context: async (workspaceId) => {
			const documents = currentDocuments(await store.snapshot(workspaceId))
				.filter(
					(item) => item.pinnedByUser || ["overview", "plan", "contract", "decision"].includes(item.document.kind),
				)
				.sort(
					(a, b) => Number(b.pinnedByUser) - Number(a.pinnedByUser) || a.document.id.localeCompare(b.document.id),
				);
			return {
				documents: documents.slice(0, 30).map(describeKnowledgeRevision),
				total: documents.length,
				truncated: documents.length > 30,
				authority: "project_index_not_task_approval",
			};
		},
		proposals: async (workspaceId, input) => {
			const items = Object.values((await store.snapshot(workspaceId)).proposals)
				.filter((item) => item.status === input.status)
				.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
			const result = page(items, input.offset, input.limit);
			return { proposals: result.items, total: result.total, nextOffset: result.nextOffset };
		},
		proposalRead: async (workspaceId, input) => {
			const proposal = (await store.snapshot(workspaceId)).proposals[input.id];
			if (!proposal) throw new KnowledgeError("NOT_FOUND", "That proposal does not exist in this project.");
			const markdown = await store.readContent(workspaceId, proposal.contentHash);
			const { offset: _offset, ...slice } = sliceKnowledgeText(markdown, input.offset, input.limit);
			return { proposal, ...slice, authority: "unpublished_proposal" };
		},
		history: async (workspaceId, input) => {
			const manifest = await store.snapshot(workspaceId);
			findKnowledgeRevision(manifest, input.id);
			const result = page([...(manifest.documents[input.id] ?? [])].reverse(), input.offset, input.limit);
			return {
				revisions: result.items.map(describeKnowledgeRevision),
				total: result.total,
				nextOffset: result.nextOffset,
			};
		},
	};
}
