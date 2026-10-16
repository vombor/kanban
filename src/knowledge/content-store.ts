import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory, writeFileSynced } from "../fs/durable-file";
import { KNOWLEDGE_MAX_CONTENT_BYTES, knowledgeRevisionSchema } from "../trpc/knowledge-contract";
import { KnowledgeError } from "./knowledge-error";

export function hashKnowledgeContent(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
export async function readKnowledgeFile(path: string, maxBytes: number): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > maxBytes)
			throw new KnowledgeError("PRECONDITION_FAILED", "The knowledge file is not a bounded regular file.");
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}
export function createKnowledgeContentStore(objectsPath: string) {
	const pathOf = (hash: string) => join(objectsPath, `${knowledgeRevisionSchema.parse(hash)}.md`);
	const read = async (hash: string) => {
		let markdown: string;
		try {
			markdown = await readKnowledgeFile(pathOf(hash), KNOWLEDGE_MAX_CONTENT_BYTES);
		} catch {
			throw new KnowledgeError(
				"PRECONDITION_FAILED",
				"Knowledge content is missing or unreadable; restore it before updating the manifest.",
			);
		}
		if (hashKnowledgeContent(markdown) !== hash)
			throw new KnowledgeError("PRECONDITION_FAILED", "Knowledge content failed its integrity check.");
		return markdown;
	};
	return {
		read,
		ensure: async (markdown: string) => {
			if (Buffer.byteLength(markdown, "utf8") > KNOWLEDGE_MAX_CONTENT_BYTES)
				throw new KnowledgeError("BAD_REQUEST", "The knowledge document is too large.");
			const hash = hashKnowledgeContent(markdown);
			const path = pathOf(hash);
			await mkdir(objectsPath, { recursive: true, mode: 0o700 });
			const temporary = join(objectsPath, `.${randomUUID()}.tmp`);
			try {
				await writeFileSynced(temporary, markdown, { mode: 0o600, flag: "wx" });
				try {
					await link(temporary, path);
					await syncDirectory(objectsPath);
				} catch (error) {
					if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
					if ((await read(hash)) !== markdown)
						throw new KnowledgeError(
							"PRECONDITION_FAILED",
							"The immutable knowledge object does not match its revision.",
						);
				}
			} finally {
				await rm(temporary, { force: true });
			}
			return hash;
		},
	};
}
