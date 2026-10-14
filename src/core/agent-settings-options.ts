// Read-only picker metadata, not a model allow list or a change to launch/routing policy.
import { z } from "zod";
import { runtimeAgentIdSchema } from "./api-contract";

export const agentSettingsOptionSchema = z.object({ value: z.string(), label: z.string() });
export const agentModelOptionSchema = z.object({
	modelId: z.string(),
	label: z.string(),
	providerId: z.string().optional(),
	reasoningEfforts: z.array(z.string()),
});
export const agentSettingsOptionsRequestSchema = z.object({ agentId: runtimeAgentIdSchema });
export const agentSettingsOptionsSchema = z.object({
	models: z.array(agentModelOptionSchema),
	providers: z.array(agentSettingsOptionSchema),
	efforts: z.array(agentSettingsOptionSchema),
	source: z.string(),
	error: z.string().optional(),
});
export type AgentSettingsOptions = z.infer<typeof agentSettingsOptionsSchema>;
export type AgentModelOption = z.infer<typeof agentModelOptionSchema>;
