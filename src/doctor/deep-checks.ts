// `kanban doctor --deep`: the slower machine checks, run before trusting a new image or machine (agent CLIs and
// their versions, env, ssh key, Cline providers). Ported from archive/devteam-kit:bin/post-switch-check.mjs@760fd36
// (`kit switch-check`). Dropped from it: the "default agent is not claude" warning (the orchestrator is whichever
// agent is selected, plan §4.0), the `npx -y kanban` probe (network) and the kit-service checks (the one-owner
// check covers them).
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PipelineConfig } from "../config/pipeline-config";
import { RUNTIME_AGENT_CATALOG } from "../core/agent-catalog";
import type { RuntimeAgentId } from "../core/api-contract";
import {
	type DeprecatedProviderEntry,
	findDeprecatedProviderEntries,
	getProviderSettingsPaths,
	readClineProvidersFile,
} from "../models/cline-providers";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import type { DoctorFinding } from "./doctor-report";

export interface DeepCheckDeps {
	env: NodeJS.ProcessEnv;
	isOnPath: (binary: string) => boolean;
	/** First line of `<binary> <args>`'s output, or null when it fails. */
	readVersion: (binary: string, args: string[]) => Promise<string | null>;
	readClineProviders: () => Promise<unknown>;
	/** The deprecated provider workarounds `kanban models providers` reports (P3-3's scan). */
	findDeprecatedProviders: () => Promise<DeprecatedProviderEntry[]>;
	sshKeyPaths: string[];
	fileMode: (path: string) => Promise<number | null>;
}

const VERSION_TIMEOUT_MS = 15_000;

export function createDeepCheckDeps(config: PipelineConfig): DeepCheckDeps {
	const paths = getProviderSettingsPaths(config);
	return {
		env: process.env,
		isOnPath: isBinaryAvailableOnPath,
		readVersion: (binary, args) =>
			new Promise((resolveVersion) => {
				execFile(binary, args, { timeout: VERSION_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
					const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim().split("\n")[0]?.trim() ?? "";
					// `ssh -V` prints to stderr and exits 0; anything that printed a version counts.
					resolveVersion(error && !output ? null : output || null);
				});
			}),
		readClineProviders: () => readClineProvidersFile(paths.providersPath),
		findDeprecatedProviders: () => findDeprecatedProviderEntries(paths, config.models.providers),
		sshKeyPaths: ["id_rsa", "id_ed25519", "id_ecdsa"].map((name) => join(homedir(), ".ssh", name)),
		fileMode: async (path) => {
			try {
				return (await stat(path)).mode & 0o777;
			} catch {
				return null;
			}
		},
	};
}

// The image sets these so nothing updates itself under running cards; the image build is the update path.
const NO_SELF_UPDATE_ENV = ["KANBAN_NO_AUTO_UPDATE", "CLINE_NO_AUTO_UPDATE", "DISABLE_AUTOUPDATER"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function runDeepChecks(
	input: {
		kanbanVersion: string;
		selectedAgentId: RuntimeAgentId;
		defaultProvider: string;
	},
	deps: DeepCheckDeps,
): Promise<DoctorFinding[]> {
	const findings: DoctorFinding[] = [];
	for (const name of NO_SELF_UPDATE_ENV) {
		findings.push(
			deps.env[name] === "1"
				? { level: "pass", area: "deep", message: `env ${name}=1` }
				: {
						level: "warn",
						area: "deep",
						message: `env ${name} is ${deps.env[name] === undefined ? "unset" : `"${deps.env[name]}"`}: a self-update can change a CLI under running cards`,
					},
		);
	}
	if (deps.env.NODE_ENV) {
		findings.push({
			level: "warn",
			area: "deep",
			message: `NODE_ENV=${deps.env.NODE_ENV} (agents' npm installs skip devDependencies)`,
		});
	}

	if (!deps.isOnPath("kanban")) {
		findings.push({ level: "warn", area: "deep", message: "no kanban on PATH: agents' kanban commands fail" });
	} else {
		const version = await deps.readVersion("kanban", ["--version"]);
		findings.push(
			version?.includes(input.kanbanVersion)
				? { level: "pass", area: "deep", message: `kanban on PATH is ${version}` }
				: {
						level: "warn",
						area: "deep",
						message: `kanban on PATH is ${version ?? "unreadable"}, this is ${input.kanbanVersion}: agents run a different Kanban`,
					},
		);
	}

	for (const agent of RUNTIME_AGENT_CATALOG) {
		const selected = agent.id === input.selectedAgentId;
		if (!deps.isOnPath(agent.binary)) {
			findings.push({
				level: selected ? "fail" : "info",
				area: "deep",
				message: `${agent.label} (${agent.binary}) is not on PATH${selected ? ": it is the selected agent, so new cards and the orchestrator can't start" : ""}`,
				hint: agent.installUrl,
			});
			continue;
		}
		const version = await deps.readVersion(agent.binary, ["--version"]);
		if (agent.id === "cline" && version !== null && !/^3\./u.test(version)) {
			findings.push({
				level: "warn",
				area: "deep",
				message: `cline --version is ${version}; Kanban's Cline agent is the cline 3.x CLI`,
			});
			continue;
		}
		findings.push({
			level: version === null ? "warn" : "pass",
			area: "deep",
			message: `${agent.binary} on PATH${version === null ? ", but --version failed" : `: ${version}`}${selected ? " (selected agent)" : ""}`,
		});
	}

	for (const [binary, args, level] of [
		["git", ["--version"], "fail"],
		["ssh", ["-V"], "warn"],
	] as const) {
		const version = deps.isOnPath(binary) ? await deps.readVersion(binary, [...args]) : null;
		findings.push(
			version
				? { level: "pass", area: "deep", message: `${binary}: ${version}` }
				: { level, area: "deep", message: `${binary} is not on PATH or doesn't run` },
		);
	}
	for (const keyPath of deps.sshKeyPaths) {
		const mode = await deps.fileMode(keyPath);
		if (mode !== null && mode !== 0o600 && mode !== 0o400) {
			findings.push({
				level: "fail",
				area: "deep",
				message: `${keyPath} has mode ${mode.toString(8)}; ssh refuses a private key others can read`,
				hint: `chmod 600 ${keyPath}`,
			});
		}
	}

	if (deps.isOnPath("cline")) {
		const document = await deps.readClineProviders();
		const providers = isRecord(document) && isRecord(document.providers) ? document.providers : {};
		const entry = providers[input.defaultProvider];
		const hasKey = isRecord(entry) && isRecord(entry.settings) && Boolean(entry.settings.apiKey);
		findings.push(
			hasKey
				? {
						level: "pass",
						area: "deep",
						message: `Cline providers.json has a ${input.defaultProvider} entry with a key`,
					}
				: {
						level: "warn",
						area: "deep",
						message: `Cline providers.json has no ${input.defaultProvider} entry with an apiKey (models.providers.default)`,
						hint: "kanban setup (with BEDROCK_API_KEY set)",
					},
		);
		const deprecated = await deps.findDeprecatedProviders();
		const removable = deprecated.filter((entry) => !entry.keep);
		if (removable.length > 0) {
			findings.push({
				level: "warn",
				area: "deep",
				message: `deprecated provider workarounds left: ${removable.map((entry) => entry.what).join("; ")}`,
				hint: "kanban models providers --cleanup (lists the edits to make in Cline's files)",
			});
		}
		for (const entry of deprecated.filter((candidate) => candidate.keep)) {
			findings.push({ level: "info", area: "deep", message: `${entry.what} in ${entry.file}: ${entry.note}` });
		}
	}
	return findings;
}
