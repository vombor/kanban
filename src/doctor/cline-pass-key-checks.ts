// Doctor row: whether Cline cards on ClinePass (`cline-pass`) start. Cline's TUI only counts credentials stored in
// providers.json (src/terminal/cline-tui-sign-in.ts), so without a stored key every cline-pass card sits on Cline's
// sign-in screen, as Bedrock's did (issue #9). `kanban setup-provider cline-pass`
// (src/setup/cline-pass-key.ts) stores CLINE_API_KEY from Kanban's environment. Read-only and never prints a key value.

import { readClineProvidersFile } from "../setup/cline-bedrock-key";
import {
	CLINE_PASS_AUTH_DOC,
	CLINE_PASS_KEY_ENV,
	describeClinePassKey,
	describeClinePassKeyProblems,
	STORE_CLINE_PASS_KEY_COMMAND,
} from "../setup/cline-pass-key";
import { CLINE_PASS_PROVIDER_ID, getClineProviderSettings } from "../terminal/cline-tui-sign-in";
import type { DoctorFinding } from "./doctor-report";

const AREA = "setup";

export interface ClinePassKeyCheckOptions {
	providersPath: string;
	/** `models.providers.default`. */
	defaultProvider: string;
	env: NodeJS.ProcessEnv;
}

export async function checkClinePassKey(options: ClinePassKeyCheckOptions): Promise<DoctorFinding[]> {
	const read = await readClineProvidersFile(options.providersPath);
	if (read.kind === "invalid") {
		return [{ level: "warn", area: AREA, message: `cline ClinePass key (${options.providersPath}): ${read.detail}` }];
	}
	const document = read.kind === "found" ? read.document : null;
	const facts = describeClinePassKey(document, options.env);
	// ClinePass is in use when it is Kanban's default provider, Cline has a cline-pass entry, or the env has its key. A
	// `cline` entry alone (Cline's own usage-billing provider) says nothing about ClinePass.
	const inUse =
		options.defaultProvider === CLINE_PASS_PROVIDER_ID ||
		getClineProviderSettings(document, CLINE_PASS_PROVIDER_ID) !== null ||
		facts.envKey;
	if (!inUse) {
		return [];
	}
	const problems = describeClinePassKeyProblems(facts, options.providersPath);
	if (problems.length === 0) {
		return [
			{
				level: "pass",
				area: AREA,
				message:
					facts.credential === "sign-in"
						? `Cline uses the Cline account sign-in stored in ${options.providersPath} for ClinePass`
						: `Cline's ClinePass key is stored in ${options.providersPath}${
								facts.storedKey === "same" ? ` (the same value as ${CLINE_PASS_KEY_ENV})` : ""
							}`,
			},
		];
	}
	// Storing needs the env's key; without it the hint is the doc (set the secret first).
	const hint = facts.envKey ? STORE_CLINE_PASS_KEY_COMMAND : CLINE_PASS_AUTH_DOC;
	return problems.map((problem) => ({
		level: problem.level,
		area: AREA,
		message: problem.message,
		...(problem.level === "warn" ? { hint } : {}),
	}));
}
