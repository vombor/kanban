// `providers.openaiCompatible.<id>` in config.json: model servers that speak the OpenAI chat API (Triton/TensorRT-LLM's
// router, vLLM, ...), set up for Cline cards as a custom models.json provider by `kanban setup-provider <id>`
// (src/setup/cline-openai-compatible-provider.ts). The next server like that needs only an entry here, no code.
//
//   name       Cline's display name for the provider;
//   baseUrl    the server's OpenAI API base, with its version path (`http://host/v1`): where Cline sends chat
//              completions and Kanban reads `GET <baseUrl>/models`;
//   apiKeyEnv  the variable in Kanban's environment holding the server's key, stored in providers.json by the command
//              (none: a keyless server, as Triton is);
//   local      true for the user's own hardware: turns price at 0 and a QA card takes no cloud QA slot
//              (`isLocalProvider`, src/kits/team/bench/prices.ts);
//   models     per model id, the context window (and max output tokens) to write when the server reports none or the
//              wrong one; the command never adds a model to models.json (the orchestrator curates that list).
import { z } from "zod";

import { SETUP_PROVIDER_IDS } from "../setup/setup-provider-command";

/** Ids an entry can't take: the providers `kanban setup-provider` has its own code for, and Cline's own account. */
const RESERVED_PROVIDER_IDS: readonly string[] = [...SETUP_PROVIDER_IDS, "cline"];

const providerIdSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]*$/u, "expected a lower-case provider id (letters, digits, -)")
	.refine((id) => !RESERVED_PROVIDER_IDS.includes(id), {
		message: `reserved provider id (${RESERVED_PROVIDER_IDS.join(", ")})`,
	});

const openAiCompatibleModelSchema = z
	.object({
		contextWindow: z.number().int().positive(),
		/** Default: a quarter of the window, at most 32K (maxTokensForContextWindow). */
		maxTokens: z.number().int().positive().optional(),
	})
	.strict();

export const openAiCompatibleProviderSchema = z
	.object({
		name: z.string().trim().min(1),
		baseUrl: z.string().refine(
			(value) => {
				try {
					return ["http:", "https:"].includes(new URL(value).protocol);
				} catch {
					return false;
				}
			},
			{ message: "expected an http(s) URL" },
		),
		apiKeyEnv: z
			.string()
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "expected an environment variable name")
			.optional(),
		local: z.boolean(),
		models: z.record(z.string().min(1), openAiCompatibleModelSchema).default({}),
	})
	.strict();

export type OpenAiCompatibleProviderSettings = z.infer<typeof openAiCompatibleProviderSchema>;
export type OpenAiCompatibleModelOverride = z.infer<typeof openAiCompatibleModelSchema>;

export const openAiCompatibleProvidersSchema = z.record(providerIdSchema, openAiCompatibleProviderSchema).default({});
