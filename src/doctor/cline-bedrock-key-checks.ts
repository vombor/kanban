// Doctor row: where Cline cards get their Bedrock key. The environment (AWS_BEARER_TOKEN_BEDROCK, a podman secret in
// the container) is the recommended source; a key stored in Cline's providers.json is reported with the user's
// command that removes it (`kanban cline remove-bedrock-key`, src/setup/cline-bedrock-key.ts). It replaces setup's
// cline-providers step in doctor (skipSteps), so the region is checked here too. Read-only, never prints a key value,
// and the Kanban server's and the Cline hub daemons' env is compared, never shown.
import {
	BEDROCK_PODMAN_SECRET_LINE,
	CLINE_BEDROCK_AUTH_DOC,
	CLINE_BEDROCK_KEY_ENV,
	type ClineKeyLauncherDeps,
	describeClineBedrockKey,
	describeClineKeyLauncher,
	describeStoredBedrockKey,
	listClineKeyLaunchers,
	REMOVE_BEDROCK_KEY_COMMAND,
	readClineBedrockSettings,
} from "../setup/cline-bedrock-key";
import type { DoctorFinding } from "./doctor-report";

const AREA = "setup";

export interface ClineBedrockKeyCheckOptions {
	providersPath: string;
	/** `models.providers.default`. */
	defaultProvider: string;
	/** `models.bedrockRegion`, for the AWS_REGION hint. */
	bedrockRegion: string;
	env: NodeJS.ProcessEnv;
	launcherDeps?: ClineKeyLauncherDeps;
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
	const findings: DoctorFinding[] = [];
	const stored = describeStoredBedrockKey(facts, options.providersPath);
	if (!facts.envKey) {
		findings.push({
			level: "warn",
			area: AREA,
			message:
				facts.storedKey === "none"
					? `${CLINE_BEDROCK_KEY_ENV} is not set and ${options.providersPath} stores no Bedrock key: Cline's Bedrock cards have no key (podman: ${BEDROCK_PODMAN_SECRET_LINE})`
					: `${CLINE_BEDROCK_KEY_ENV} is not set, but Cline uses Bedrock: ${stored}`,
			hint: CLINE_BEDROCK_AUTH_DOC,
		});
	} else if (stored === null) {
		findings.push({
			level: "pass",
			area: AREA,
			message: `Cline's Bedrock key comes from ${CLINE_BEDROCK_KEY_ENV}; none stored in ${options.providersPath}`,
		});
	} else if (facts.withoutStoredKey === "env") {
		findings.push({ level: "warn", area: AREA, message: stored, hint: REMOVE_BEDROCK_KEY_COMMAND });
	} else {
		findings.push({ level: "info", area: AREA, message: stored });
	}

	if (facts.envKey && facts.withoutStoredKey === "env") {
		const envValue = options.env[CLINE_BEDROCK_KEY_ENV]?.trim() ?? null;
		for (const launcher of await listClineKeyLaunchers(envValue, options.launcherDeps)) {
			if (launcher.env === "same") {
				continue;
			}
			findings.push({
				// With a stored key it still works; without one its Bedrock cards have no key (or another one).
				level: facts.storedKey === "none" ? "warn" : "info",
				area: AREA,
				message: `${describeClineKeyLauncher(launcher)}: ${
					facts.storedKey === "none"
						? "the Cline cards it serves have no Bedrock key (or another one) until it restarts"
						: `it uses the stored key; ${REMOVE_BEDROCK_KEY_COMMAND} waits until it is restarted from this environment`
				}`,
				hint: CLINE_BEDROCK_AUTH_DOC,
			});
		}
	}

	if (!facts.region) {
		findings.push({
			level: "warn",
			area: AREA,
			message: `no Bedrock region for Cline: export AWS_REGION=${options.bedrockRegion} before starting Kanban`,
		});
	}
	return findings;
}
