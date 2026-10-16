import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { renameDurably, syncDirectory, writeFileSynced } from "../fs/durable-file";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getProjectKnowledgePaths } from "../state/kanban-home";
import {
	type KnowledgeActor,
	type KnowledgeMutation,
	type KnowledgeMutationResult,
	knowledgeMutationSchema,
} from "../trpc/knowledge-contract";
import { createKnowledgeContentStore, readKnowledgeFile } from "./content-store";
import { KnowledgeError } from "./knowledge-error";
import { applyKnowledgeMutation, assertKnowledgeMutationActor, knowledgeRequestHash } from "./knowledge-mutations";
import { validateKnowledgeManifest } from "./knowledge-revisions";
import { emptyKnowledgeManifest, type KnowledgeManifest, knowledgeManifestSchema } from "./knowledge-schema";

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export interface ProjectKnowledgeStore {
	snapshot: (workspaceId: string) => Promise<KnowledgeManifest>;
	readContent: (workspaceId: string, hash: string) => Promise<string>;
	mutate: (workspaceId: string, actor: KnowledgeActor, input: KnowledgeMutation) => Promise<KnowledgeMutationResult>;
}
export function createProjectKnowledgeStore(
	options: { homePath?: string; now?: () => Date; beforeCommit?: () => Promise<void> } = {},
): ProjectKnowledgeStore {
	const pathsOf = (workspaceId: string) => getProjectKnowledgePaths(workspaceId, options.homePath);
	const contentOf = (workspaceId: string) => createKnowledgeContentStore(pathsOf(workspaceId).objects);
	const snapshot = async (workspaceId: string): Promise<KnowledgeManifest> => {
		let text: string;
		try {
			text = await readKnowledgeFile(pathsOf(workspaceId).manifest, MAX_MANIFEST_BYTES);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
				return emptyKnowledgeManifest();
			throw new KnowledgeError(
				"PRECONDITION_FAILED",
				"The knowledge manifest is unreadable; existing data was not overwritten.",
			);
		}
		try {
			const manifest = knowledgeManifestSchema.parse(JSON.parse(text));
			validateKnowledgeManifest(manifest);
			return manifest;
		} catch {
			throw new KnowledgeError(
				"PRECONDITION_FAILED",
				"The knowledge manifest is damaged or unsupported; restore it before writing.",
			);
		}
	};
	return {
		snapshot,
		readContent: async (workspaceId, hash) => await contentOf(workspaceId).read(hash),
		mutate: async (workspaceId, actor, raw) => {
			const input = knowledgeMutationSchema.parse(raw);
			assertKnowledgeMutationActor(actor, input);
			const paths = pathsOf(workspaceId);
			await mkdir(paths.root, { recursive: true, mode: 0o700 });
			await chmod(paths.root, 0o700);
			await syncDirectory(dirname(paths.root));
			return await lockedFileSystem.withLock({ path: paths.manifest }, async () => {
				const manifest = await snapshot(workspaceId);
				const requestHash = knowledgeRequestHash(actor, input);
				const receipt = manifest.receipts[input.requestId];
				if (receipt) {
					if (receipt.requestHash !== requestHash)
						throw new KnowledgeError(
							"CONFLICT",
							"That request id was already used for a different operation or author.",
						);
					return receipt.result;
				}
				const content = contentOf(workspaceId);
				// Refuse dangling/corrupt historical objects rather than writing over an apparently healthy index.
				const hashes = new Set([
					...Object.values(manifest.documents).flatMap((items) => items.map((item) => item.contentHash)),
					...Object.values(manifest.proposals).map((item) => item.contentHash),
				]);
				for (const hash of hashes) await content.read(hash);
				let proposalMarkdown: string | undefined;
				if (input.action === "review" && input.decision === "publish") {
					const proposal = manifest.proposals[input.proposalId];
					if (proposal) proposalMarkdown = await content.read(proposal.contentHash);
				}
				const result = applyKnowledgeMutation(
					manifest,
					actor,
					input,
					(options.now?.() ?? new Date()).toISOString(),
					proposalMarkdown,
				);
				manifest.receipts[input.requestId] = { requestHash, result };
				validateKnowledgeManifest(manifest);
				const text = `${JSON.stringify(knowledgeManifestSchema.parse(manifest), null, 2)}\n`;
				if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES)
					throw new KnowledgeError(
						"PRECONDITION_FAILED",
						"Knowledge history reached its size limit; archive it before adding more.",
					);
				if (input.action === "publish" || input.action === "propose") await content.ensure(input.markdown);
				await options.beforeCommit?.();
				const temporary = `${paths.manifest}.${randomUUID()}.tmp`;
				try {
					await writeFileSynced(temporary, text, { mode: 0o600, flag: "wx" });
					await renameDurably(temporary, paths.manifest);
				} finally {
					await rm(temporary, { force: true });
				}
				return result;
			});
		},
	};
}
