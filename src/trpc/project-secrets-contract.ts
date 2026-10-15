import { z } from "zod";
import type { RuntimeCaller } from "../isolation/session-identity";

export const projectSecretNameSchema = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, "Use an environment-variable name")
	.refine((name) => !["__proto__", "prototype", "constructor"].includes(name), "That name is reserved");
export const projectSecretInputSchema = z.object({
	name: projectSecretNameSchema,
	value: z.string().min(1).max(65536),
});
export const projectSecretsWriteSchema = z.object({
	secrets: z
		.array(projectSecretInputSchema)
		.max(100)
		.refine(
			(secrets) => new Set(secrets.map((secret) => secret.name)).size === secrets.length,
			"Secret names must be unique",
		),
});
export const projectSecretMetadataSchema = z.object({
	name: projectSecretNameSchema,
	configured: z.literal(true),
	updatedAt: z.string(),
});
export const projectSecretsMetadataSchema = z.object({ secrets: z.array(projectSecretMetadataSchema) });
export const projectSecretsRemoveSchema = z.object({ name: projectSecretNameSchema });
export type ProjectSecretInput = z.infer<typeof projectSecretInputSchema>;
export type ProjectSecretMetadata = z.infer<typeof projectSecretMetadataSchema>;
export interface RuntimeProjectSecretsApi {
	list: (input: { caller: RuntimeCaller; workspaceId: string }) => Promise<{ secrets: ProjectSecretMetadata[] }>;
	set: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		secrets: ProjectSecretInput[];
	}) => Promise<{ secrets: ProjectSecretMetadata[] }>;
	remove: (input: {
		caller: RuntimeCaller;
		workspaceId: string;
		name: string;
	}) => Promise<{ secrets: ProjectSecretMetadata[] }>;
}
