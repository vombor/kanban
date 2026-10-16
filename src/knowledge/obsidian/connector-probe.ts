import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { Agent, fetch, type Response } from "undici";
import { z } from "zod";
import type { ObsidianConnectorProbe } from "../../trpc/obsidian-connector-contract";
import type { ObsidianConnectorRecord } from "./connector-store";

const statusSchema = z.object({
	authenticated: z.boolean(),
	versions: z.object({ self: z.string().max(80) }).optional(),
	state: z
		.object({
			metadataCache: z
				.object({
					listeningSince: z.string().optional(),
					lastActivityAt: z.string().nullable().optional(),
				})
				.optional(),
		})
		.optional(),
});
const openApiSchema = z.object({
	paths: z.record(z.string(), z.unknown()),
	components: z
		.object({
			schemas: z.object({ NoteJson: z.object({ properties: z.record(z.string(), z.unknown()) }).optional() }),
		})
		.optional(),
});
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
async function readBoundedJson(response: Response): Promise<unknown> {
	if (!response.body) throw new Error("Missing response body");
	const chunks: Buffer[] = [];
	let size = 0;
	const reader = response.body.getReader();
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			const chunk = Buffer.from(part.value);
			size += chunk.length;
			if (size > MAX_RESPONSE_BYTES) throw new Error("Response exceeds the discovery limit");
			chunks.push(chunk);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export async function probeObsidianConnector(record: ObsidianConnectorRecord): Promise<ObsidianConnectorProbe> {
	const empty = { graph: false, search: false, documentMap: false };
	if (!record.settings.baseUrl || !record.apiKey) {
		return {
			ok: false,
			message: "Enter an endpoint and an API key before testing.",
			version: null,
			capabilities: empty,
			indexing: "unknown",
		};
	}
	const { baseUrl, caCertificate } = record.settings;
	let agent: Agent | undefined;
	try {
		if (caCertificate) {
			const certificate = new X509Certificate(caCertificate);
			if (!certificate.ca) throw new Error("Not a CA certificate");
			agent = new Agent({ connect: { ca: [...rootCertificates, caCertificate] } });
		}
		const signal = AbortSignal.timeout(10_000);
		const read = async (path: string) => {
			const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/${path}`, {
				headers: { Authorization: `Bearer ${record.apiKey}`, Accept: "application/json" },
				redirect: "error",
				signal,
				dispatcher: agent,
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error("Obsidian request refused");
			}
			return await readBoundedJson(response);
		};
		const status = statusSchema.parse(await read(""));
		if (!status.authenticated) {
			return {
				ok: false,
				message: "The REST API did not authenticate the supplied API key.",
				version: null,
				capabilities: empty,
				indexing: "unknown",
			};
		}
		const api = openApiSchema.parse(await read("openapi.json"));
		const props = api.components?.schemas.NoteJson?.properties ?? {};
		const capabilities = {
			graph: ["links", "backlinks", "unresolvedLinks"].every((key) => Object.hasOwn(props, key)),
			search: Object.hasOwn(api.paths, "/search/"),
			documentMap: JSON.stringify(api.paths["/vault/{filename}"] ?? {}).includes(
				"application/vnd.olrapi.document-map+json",
			),
		};
		const cache = status.state?.metadataCache;
		const at = Date.parse(cache?.lastActivityAt ?? cache?.listeningSince ?? "");
		const indexing = Number.isFinite(at) ? (Date.now() - at < 5000 ? "recent_activity" : "quiet") : "unknown";
		return {
			ok: true,
			message: "Authenticated REST API connection verified.",
			version: status.versions?.self.includes(record.apiKey) ? null : (status.versions?.self ?? null),
			capabilities,
			indexing,
		};
	} catch {
		// Upstream messages/URLs can echo credentials or private data. Never return them to telemetry or the UI.
		return {
			ok: false,
			message:
				"Connection test failed. Check the endpoint, API key, network access and CA certificate. Redirects are not followed.",
			version: null,
			capabilities: empty,
			indexing: "unknown",
		};
	} finally {
		await agent?.close();
	}
}
