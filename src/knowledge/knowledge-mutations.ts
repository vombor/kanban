import { createHash } from "node:crypto";
import type {
	KnowledgeActor,
	KnowledgeMutation,
	KnowledgeMutationResult,
	KnowledgeProposal,
} from "../trpc/knowledge-contract";
import { hashKnowledgeContent } from "./content-store";
import { KnowledgeError } from "./knowledge-error";
import { currentKnowledgeRevision, describeKnowledgeRevision, hashKnowledgeRevision } from "./knowledge-revisions";
import type { KnowledgeManifest, KnowledgeStoredRevision } from "./knowledge-schema";
import { describeKnowledgeMarkdown } from "./markdown";

export function assertKnowledgeMutationActor(actor: KnowledgeActor, input: KnowledgeMutation): void {
	if (input.action === "pin" && actor.kind !== "user")
		throw new KnowledgeError("FORBIDDEN", "Only the user can pin or unpin project knowledge.");
	if (input.action !== "propose" && actor.kind === "session" && actor.role !== "orchestrator") {
		throw new KnowledgeError(
			"FORBIDDEN",
			"Cards may propose knowledge; only the user or this project's orchestrator publishes/reviews it.",
		);
	}
}
export function knowledgeRequestHash(actor: KnowledgeActor, input: KnowledgeMutation): string {
	return createHash("sha256").update(JSON.stringify({ actor, input })).digest("hex");
}

/** Pure canonical history update. No approval, kit, board, task start or landing side effects. */
export function applyKnowledgeMutation(
	manifest: KnowledgeManifest,
	actor: KnowledgeActor,
	input: KnowledgeMutation,
	at: string,
	markdown?: string,
): KnowledgeMutationResult {
	const writeRevision = (document: KnowledgeStoredRevision["document"], content: string, expected: string | null) => {
		const previous = currentKnowledgeRevision(manifest, document.id);
		if ((previous?.revision ?? null) !== expected)
			throw new KnowledgeError(
				"CONFLICT",
				"Knowledge changed since the revision you read; reload before publishing.",
			);
		if (previous?.pinnedByUser && actor.kind !== "user")
			throw new KnowledgeError("FORBIDDEN", "This document is user-pinned. Submit a proposal for the user instead.");
		const payload: Omit<KnowledgeStoredRevision, "revision"> = {
			parentRevision: previous?.revision ?? null,
			document,
			contentHash: hashKnowledgeContent(content),
			contentBytes: Buffer.byteLength(content, "utf8"),
			sections: describeKnowledgeMarkdown(content).sections,
			pinnedByUser: previous?.pinnedByUser ?? false,
			publishedAt: at,
			publishedBy: actor,
			action: "publish",
		};
		const revision = { revision: hashKnowledgeRevision(payload), ...payload };
		manifest.documents[document.id] = [...(manifest.documents[document.id] ?? []), revision];
		return describeKnowledgeRevision(revision);
	};
	if (input.action === "publish")
		return { kind: "document", document: writeRevision(input.document, input.markdown, input.expectedRevision) };
	if (input.action === "propose") {
		const previous = currentKnowledgeRevision(manifest, input.document.id);
		if ((previous?.revision ?? null) !== input.expectedRevision)
			throw new KnowledgeError(
				"CONFLICT",
				"Knowledge changed since the proposal's base revision; reload before proposing.",
			);
		describeKnowledgeMarkdown(input.markdown);
		const proposal: KnowledgeProposal = {
			id: input.requestId,
			document: input.document,
			baseRevision: input.expectedRevision,
			contentHash: hashKnowledgeContent(input.markdown),
			reason: input.reason,
			status: "pending",
			submittedAt: at,
			submittedBy: actor,
			reviewedAt: null,
			reviewedBy: null,
			publishedRevision: null,
		};
		manifest.proposals[proposal.id] = proposal;
		return { kind: "proposal", proposal };
	}
	if (input.action === "review") {
		const previous = manifest.proposals[input.proposalId];
		if (!previous) throw new KnowledgeError("NOT_FOUND", "That proposal does not exist in this project.");
		if (previous.status !== "pending")
			throw new KnowledgeError("CONFLICT", "That proposal has already been reviewed.");
		const current = currentKnowledgeRevision(manifest, previous.document.id);
		if (current?.pinnedByUser && actor.kind !== "user")
			throw new KnowledgeError("FORBIDDEN", "Only the user reviews changes to a user-pinned document.");
		let publishedRevision: string | null = null;
		if (input.decision === "publish") {
			if (input.expectedRevision !== previous.baseRevision)
				throw new KnowledgeError(
					"CONFLICT",
					"A stale proposal must be resubmitted against the current revision, not silently rebased.",
				);
			if (markdown === undefined)
				throw new KnowledgeError("PRECONDITION_FAILED", "The proposal content is unavailable.");
			publishedRevision = writeRevision(previous.document, markdown, input.expectedRevision).revision;
		}
		const proposal = {
			...previous,
			status: input.decision === "publish" ? ("published" as const) : ("rejected" as const),
			reviewedAt: at,
			reviewedBy: actor,
			publishedRevision,
		};
		manifest.proposals[proposal.id] = proposal;
		return { kind: "proposal", proposal };
	}
	const previous = currentKnowledgeRevision(manifest, input.id);
	if (!previous) throw new KnowledgeError("NOT_FOUND", "That document does not exist in this project.");
	if (previous.revision !== input.expectedRevision)
		throw new KnowledgeError("CONFLICT", "Knowledge changed before the pin update; reload first.");
	const payload = {
		...previous,
		parentRevision: previous.revision,
		pinnedByUser: input.pinned,
		publishedAt: at,
		publishedBy: actor,
		action: "pin" as const,
	};
	const revision = { ...payload, revision: hashKnowledgeRevision(payload) };
	manifest.documents[input.id] = [...(manifest.documents[input.id] ?? []), revision];
	return { kind: "document", document: describeKnowledgeRevision(revision) };
}
