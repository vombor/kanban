import { createHash } from "node:crypto";
import type { KnowledgeDocument } from "../trpc/knowledge-contract";
import { KnowledgeError } from "./knowledge-error";
import type { KnowledgeManifest, KnowledgeStoredRevision } from "./knowledge-schema";

/** Explicit key order keeps revision hashes stable across parsing and object construction. */
export function hashKnowledgeRevision(revision: Omit<KnowledgeStoredRevision, "revision">): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				parentRevision: revision.parentRevision,
				document: revision.document,
				contentHash: revision.contentHash,
				contentBytes: revision.contentBytes,
				sections: revision.sections,
				pinnedByUser: revision.pinnedByUser,
				publishedAt: revision.publishedAt,
				publishedBy: revision.publishedBy,
				action: revision.action,
			}),
		)
		.digest("hex");
}
export function describeKnowledgeRevision(revision: KnowledgeStoredRevision): KnowledgeDocument {
	return {
		...revision.document,
		revision: revision.revision,
		contentHash: revision.contentHash,
		contentBytes: revision.contentBytes,
		sectionCount: revision.sections.length,
		pinnedByUser: revision.pinnedByUser,
		publishedAt: revision.publishedAt,
		publishedBy: revision.publishedBy,
	};
}
export function currentKnowledgeRevision(manifest: KnowledgeManifest, id: string): KnowledgeStoredRevision | null {
	return manifest.documents[id]?.at(-1) ?? null;
}
export function findKnowledgeRevision(
	manifest: KnowledgeManifest,
	id: string,
	revision?: string,
): KnowledgeStoredRevision {
	const found = revision
		? manifest.documents[id]?.find((item) => item.revision === revision)
		: currentKnowledgeRevision(manifest, id);
	if (!found)
		throw new KnowledgeError("NOT_FOUND", "That knowledge document/revision does not exist in this project.");
	return found;
}
export function validateKnowledgeManifest(manifest: KnowledgeManifest): void {
	let revisionCount = 0;
	for (const [id, revisions] of Object.entries(manifest.documents)) {
		let parent: string | null = null;
		for (const revision of revisions) {
			if (
				revision.document.id !== id ||
				revision.parentRevision !== parent ||
				hashKnowledgeRevision(revision) !== revision.revision
			) {
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"Knowledge revision history failed its integrity check; restore the manifest before writing.",
				);
			}
			parent = revision.revision;
			revisionCount += 1;
		}
	}
	for (const [id, proposal] of Object.entries(manifest.proposals)) {
		if (proposal.id !== id)
			throw new KnowledgeError("PRECONDITION_FAILED", "Knowledge proposal identity is damaged.");
	}
	if (
		Object.keys(manifest.documents).length > 500 ||
		revisionCount > 4000 ||
		Object.keys(manifest.proposals).length > 1000 ||
		Object.keys(manifest.receipts).length > 4096
	) {
		throw new KnowledgeError(
			"PRECONDITION_FAILED",
			"The project knowledge store reached its retention ceiling; export/archive it before adding more history.",
		);
	}
}
