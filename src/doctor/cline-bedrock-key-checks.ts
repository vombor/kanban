// Doctor row: whether Cline cards on Bedrock start. Cline's TUI only counts credentials stored in providers.json
// (src/terminal/cline-tui-sign-in.ts), so the key must be stored there; without it every Bedrock card sits on Cline's
// sign-in screen (issue #9). The user's `kanban cline store-bedrock-key` (src/setup/cline-bedrock-key.ts) stores
// AWS_BEARER_TOKEN_BEDROCK from Kanban's environment. It replaces setup's cline-providers step in doctor (skipSteps),
// so the region is checked here too. Read-only and never prints a key value.
import {
	CLINE_BEDROCK_AUTH_DOC,
	CLINE_BEDROCK_KEY_ENV,
	describeBedrockKeyProblems,
	describeClineBedrockKey,
	readClineBedrockSettings,
	STORE_BEDROCK_KEY_COMMAND,
} from "../setup/cline-bedrock-key";
import type { DoctorFinding } from "./doctor-report";

const AREA = "setup";

export interface ClineBedrockKeyCheckOptions {
	providersPath: string;
	/** `models.providers.default`. */
	defaultProvider: string;
	env: NodeJS.ProcessEnv;
}

export async function checkClineBedrockKey(options: ClineBedrockKeyCheckOptions): Promise<DoctorFinding[]> {
	const read = await readClineBedrockSettings(options.providersPath);
	if (read.kind === "invalid") {
		return [{ level: "warn", area: AREA, message: `cline bedrock key (${options.providersPath}): ${read.detail}` }];
	}
	const settings = read.kind === "found" ? read.settings : null;
	// Bedrock is in use when it is Kanban's default provider or Cline has a Bedrock entry.
	if (options.defaultProvider !== "bedrock" && settings === null) {
		return [];
	}
	const facts = describeClineBedrockKey(settings, options.env);
	const problems = describeBedrockKeyProblems(facts, options.providersPath);
	if (problems.length === 0) {
		return [
			{
				level: "pass",
				area: AREA,
				message:
					facts.credentials === "iam"
						? `Cline uses AWS credentials for Bedrock (region ${facts.storedRegion})`
						: `Cline's Bedrock key is stored in ${options.providersPath}${
								facts.storedKey === "same" ? ` (the same value as ${CLINE_BEDROCK_KEY_ENV})` : ""
							}, region ${facts.storedRegion}`,
			},
		];
	}
	// Storing needs the env's key; without it the hint is the doc (set the secret first).
	const hint = facts.envKey ? STORE_BEDROCK_KEY_COMMAND : CLINE_BEDROCK_AUTH_DOC;
	return problems.map((problem) => ({
		level: problem.level,
		area: AREA,
		message: problem.message,
		...(problem.level === "warn" ? { hint } : {}),
	}));
}
