import { z } from "zod";
import type { RuntimeCaller } from "../isolation/session-identity";

const endpointSchema = z
	.string()
	.trim()
	.max(2048)
	.refine((value) => {
		if (!value) return true;
		try {
			const url = new URL(value);
			return (
				["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
			);
		} catch {
			return false;
		}
	}, "Use an HTTP(S) endpoint without credentials, query parameters or a fragment");

export const obsidianConnectorSettingsSchema = z
	.object({
		enabled: z.boolean(),
		baseUrl: endpointSchema,
		caCertificate: z.string().trim().max(65536),
	})
	.strict()
	.refine((value) => !value.enabled || value.baseUrl.length > 0, "An enabled connector needs an endpoint");
export const obsidianConnectorWriteSchema = z
	.object({
		settings: obsidianConnectorSettingsSchema,
		expectedRevision: z.string().max(128).nullable(),
		/** Missing keeps the stored key; null removes it. Never returned by get/save/test. */
		apiKey: z.string().trim().min(1).max(65536).regex(/^\S+$/u).nullable().optional(),
	})
	.strict();
export const obsidianConnectorViewSchema = z.object({
	settings: obsidianConnectorSettingsSchema,
	revision: z.string().nullable(),
	apiKeyConfigured: z.boolean(),
});
export const obsidianConnectorProbeSchema = z.object({
	ok: z.boolean(),
	message: z.string(),
	version: z.string().nullable(),
	capabilities: z.object({ graph: z.boolean(), search: z.boolean(), documentMap: z.boolean() }),
	indexing: z.enum(["unknown", "recent_activity", "quiet"]),
});
export type ObsidianConnectorSettings = z.infer<typeof obsidianConnectorSettingsSchema>;
export type ObsidianConnectorWrite = z.infer<typeof obsidianConnectorWriteSchema>;
export type ObsidianConnectorView = z.infer<typeof obsidianConnectorViewSchema>;
export type ObsidianConnectorProbe = z.infer<typeof obsidianConnectorProbeSchema>;
export interface RuntimeObsidianConnectorApi {
	get: (caller: RuntimeCaller) => Promise<ObsidianConnectorView>;
	save: (caller: RuntimeCaller, input: ObsidianConnectorWrite) => Promise<ObsidianConnectorView>;
	test: (caller: RuntimeCaller, input: ObsidianConnectorWrite) => Promise<ObsidianConnectorProbe>;
}
