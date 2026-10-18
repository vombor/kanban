import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { Agent, fetch } from "undici";
import { z } from "zod";
import { hasControlCharacters, knowledgeMarkdownSchema } from "../../trpc/knowledge-contract";
import { discoveryPathSchema } from "../../trpc/knowledge-discovery-contract";
import type { ObsidianConnectorRecord } from "./connector-store";

const listing = z.object({ files: z.array(z.string().max(512)).max(1000) });
const note = z.object({
	path: discoveryPathSchema,
	content: knowledgeMarkdownSchema,
	links: z.array(z.string().max(512)).max(2000).default([]),
	backlinks: z.array(z.string().max(512)).max(2000).default([]),
	tags: z
		.array(
			z
				.string()
				.max(80)
				.refine((value) => !hasControlCharacters(value)),
		)
		.max(100)
		.default([]),
});
export interface ScopedObsidianReader {
	list(folder: string): Promise<string[]>;
	read(path: string): Promise<z.infer<typeof note>>;
	close(): Promise<void>;
}
/** Private GET-only client; only the broker constructs vault paths. Never a generic agent-facing proxy. */
export function createScopedObsidianReader(record: ObsidianConnectorRecord): ScopedObsidianReader {
	let dispatcher: Agent | undefined;
	if (!record.settings.enabled || !record.apiKey) throw new Error("Optional connector unavailable");
	const operation = AbortSignal.timeout(15000);
	let totalBytes = 0;
	if (record.settings.caCertificate) {
		if (!new X509Certificate(record.settings.caCertificate).ca) throw new Error("Invalid CA");
		dispatcher = new Agent({ connect: { ca: [...rootCertificates, record.settings.caCertificate] } });
	} else dispatcher = new Agent();
	const read = async (path: string, accept: string) => {
		const response = await fetch(
			`${record.settings.baseUrl.replace(/\/+$/u, "")}/vault/${path.split("/").map(encodeURIComponent).join("/")}`,
			{
				headers: { Authorization: `Bearer ${record.apiKey}`, Accept: accept },
				redirect: "error",
				signal: AbortSignal.any([operation, AbortSignal.timeout(5000)]),
				dispatcher,
			},
		);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error("Optional vault request unavailable");
		}
		if (!response.body) throw new Error("Missing body");
		const reader = response.body.getReader(),
			chunks: Buffer[] = [];
		let size = 0;
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.length;
				totalBytes += part.value.length;
				if (size > 524288 || totalBytes > 2097152) throw new Error("Vault response exceeded bound");
				chunks.push(Buffer.from(part.value));
			}
			return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	};
	return {
		list: async (folder) => {
			const files = listing.parse(await read(`${discoveryPathSchema.parse(folder)}/`, "application/json")).files;
			if (files.some((file) => file.includes(record.apiKey ?? ""))) throw new Error("Unsafe upstream response");
			return files;
		},
		read: async (path) => {
			const safe = discoveryPathSchema.parse(path),
				result = note.parse(await read(safe, "application/vnd.olrapi.note+json"));
			if (
				result.path !== safe ||
				Buffer.byteLength(result.content) > 262144 ||
				JSON.stringify(result).includes(record.apiKey ?? "")
			)
				throw new Error("Vault note identity mismatch");
			return result;
		},
		close: async () => {
			await dispatcher?.close();
		},
	};
}
