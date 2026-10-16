// Machine-wide, explicitly configured by the user. The private file is never an agent/browser read API.
import { randomUUID, X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { renameDurably, writeFileSynced } from "../../fs/durable-file";
import { lockedFileSystem } from "../../fs/locked-file-system";
import { getObsidianConnectorPath } from "../../state/kanban-home";
import {
	type ObsidianConnectorView,
	type ObsidianConnectorWrite,
	obsidianConnectorSettingsSchema,
	obsidianConnectorWriteSchema,
} from "../../trpc/obsidian-connector-contract";

const recordSchema = z
	.object({
		version: z.literal(1),
		revision: z.string().nullable(),
		settings: obsidianConnectorSettingsSchema,
		apiKey: z.string().min(1).nullable(),
	})
	.strict();
export type ObsidianConnectorRecord = z.infer<typeof recordSchema>;
export class ObsidianConnectorConflictError extends Error {}
export interface ObsidianConnectorStore {
	read: () => Promise<ObsidianConnectorRecord>;
	resolve: (input: ObsidianConnectorWrite) => Promise<ObsidianConnectorRecord>;
	save: (input: ObsidianConnectorWrite) => Promise<ObsidianConnectorView>;
}
export function obsidianConnectorView(record: ObsidianConnectorRecord): ObsidianConnectorView {
	return { settings: record.settings, revision: record.revision, apiKeyConfigured: record.apiKey !== null };
}

export function createObsidianConnectorStore(path = getObsidianConnectorPath()): ObsidianConnectorStore {
	const read = async (): Promise<ObsidianConnectorRecord> => {
		try {
			return recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				return {
					version: 1,
					revision: null,
					apiKey: null,
					settings: { enabled: false, baseUrl: "", caCertificate: "" },
				};
			}
			throw new Error("Could not read the Obsidian connector settings; the existing file was not changed.");
		}
	};
	const resolve = async (raw: ObsidianConnectorWrite): Promise<ObsidianConnectorRecord> => {
		const input = obsidianConnectorWriteSchema.parse(raw);
		const previous = await read();
		if (previous.revision !== input.expectedRevision) {
			throw new ObsidianConnectorConflictError(
				"Obsidian settings changed in another window. Reload before saving or testing.",
			);
		}
		const apiKey = input.apiKey === undefined ? previous.apiKey : input.apiKey;
		if (input.settings.enabled && !apiKey) throw new Error("An enabled Obsidian connector needs an API key.");
		let caCertificate = "";
		if (input.settings.caCertificate) {
			const certificate = new X509Certificate(input.settings.caCertificate);
			if (!certificate.ca) throw new Error("The configured certificate must be a CA certificate.");
			// Keep only the public certificate, not accidentally pasted extra PEM data.
			caCertificate = certificate.toString();
		}
		return { version: 1, revision: previous.revision, settings: { ...input.settings, caCertificate }, apiKey };
	};
	return {
		read,
		resolve,
		save: async (input) => {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await chmod(dirname(path), 0o700);
			return await lockedFileSystem.withLock({ path }, async () => {
				const record = { ...(await resolve(input)), revision: randomUUID() };
				const temporary = `${path}.${randomUUID()}.tmp`;
				try {
					await writeFileSynced(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
					await renameDurably(temporary, path);
				} finally {
					await rm(temporary, { force: true });
				}
				return obsidianConnectorView(record);
			});
		},
	};
}
