import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeAgentId } from "../core/api-contract";
import {
	type AgentWorkspaceTrustResult,
	resolvePreTrustRoot,
	resolveWorkspaceTrustRoot,
	withTrustConfigFileLock,
} from "./workspace-trust-root";

const CODEX_WORKSPACE_TRUST_TOKENS = ["do", "you", "trust", "the", "contents", "of", "this", "directory"];

export interface CodexWorkspaceTrustOptions {
	configFilePath?: string;
}

export function getCodexConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
	const codexHome = env.CODEX_HOME?.trim();
	return join(codexHome ? codexHome : join(homedir(), ".codex"), "config.toml");
}

function toTomlBasicString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const TOML_BASIC_ESCAPES: Record<string, string> = {
	b: "\b",
	t: "\t",
	n: "\n",
	f: "\f",
	r: "\r",
	'"': '"',
	"\\": "\\",
};

function decodeTomlBasicString(body: string): string {
	return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/gu, (escapeSequence, code: string) => {
		if (code.length > 1) {
			return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
		}
		return TOML_BASIC_ESCAPES[code] ?? escapeSequence;
	});
}

// The project path of a `[projects.<key>]` table header, however it is quoted or spaced; null for any
// other header.
function parseCodexProjectHeaderKey(headerInner: string): string | null {
	const match =
		/^\s*(?:projects|"projects"|'projects')\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*$/u.exec(
			headerInner,
		);
	if (!match) {
		return null;
	}
	if (match[1] !== undefined) {
		return decodeTomlBasicString(match[1]);
	}
	return match[2] ?? match[3] ?? null;
}

// trust_level of the [projects."<root>"] table: "trusted", "untrusted", another value, "" when the table
// has no trust_level, or null when there is no table.
function readCodexProjectTrustLevel(configText: string, trustRootPath: string): string | null {
	const headers = [...configText.matchAll(/^[ \t]*\[([^[\]\n]*)\][ \t]*(?:#.*)?$/gmu)];
	const header = headers.find((candidate) => parseCodexProjectHeaderKey(candidate[1] ?? "") === trustRootPath);
	if (!header) {
		return null;
	}
	const bodyStart = header.index + header[0].length;
	const body = configText.slice(bodyStart).split(/^[ \t]*\[/mu)[0] ?? "";
	return /^\s*trust_level\s*=\s*["']([^"']*)["']/mu.exec(body)?.[1] ?? "";
}

export async function getCodexWorkspaceTrustLevel(
	directory: string,
	options: CodexWorkspaceTrustOptions = {},
): Promise<string | null> {
	let configText: string;
	try {
		configText = await readFile(options.configFilePath ?? getCodexConfigFilePath(), "utf8");
	} catch {
		return null;
	}
	const { path: trustRootPath } = await resolveWorkspaceTrustRoot(directory);
	return readCodexProjectTrustLevel(configText, trustRootPath);
}

// Adds [projects."<main git root>"] trust_level = "trusted" to Codex's config.toml. The file is edited as
// text and only ever appended to; an existing entry with another value, or an inline `projects = {...}`
// table, is reported and left for the user. Calls in this process are serialised per file and re-read it
// inside the lock, so concurrent launches never append a duplicate table (which Codex refuses to load).
// Only git repositories are pre-trusted.
export async function ensureCodexWorkspaceTrusted(
	directory: string,
	options: CodexWorkspaceTrustOptions = {},
): Promise<AgentWorkspaceTrustResult> {
	const configFilePath = options.configFilePath ?? getCodexConfigFilePath();
	const { trustRootPath, error } = await resolvePreTrustRoot(directory);
	if (error) {
		return { changed: false, trustRootPath, error };
	}
	return await withTrustConfigFileLock(configFilePath, () => appendCodexProjectTrust(configFilePath, trustRootPath));
}

async function appendCodexProjectTrust(
	configFilePath: string,
	trustRootPath: string,
): Promise<AgentWorkspaceTrustResult> {
	let configText: string;
	try {
		configText = await readFile(configFilePath, "utf8");
	} catch {
		return { changed: false, trustRootPath, error: `${configFilePath} does not exist` };
	}
	const trustLevel = readCodexProjectTrustLevel(configText, trustRootPath);
	if (trustLevel === "trusted") {
		return { changed: false, trustRootPath };
	}
	const header = `[projects.${toTomlBasicString(trustRootPath)}]`;
	if (trustLevel !== null) {
		return {
			changed: false,
			trustRootPath,
			error: `${header} has trust_level "${trustLevel}"; left alone (edit it by hand)`,
		};
	}
	if (/^projects\s*=/mu.test(configText)) {
		return { changed: false, trustRootPath, error: "projects is an inline table; left alone (edit it by hand)" };
	}
	const separator = configText === "" || configText.endsWith("\n\n") ? "" : configText.endsWith("\n") ? "\n" : "\n\n";
	try {
		await appendFile(configFilePath, `${separator}${header}\ntrust_level = "trusted"\n`);
	} catch (error) {
		return {
			changed: false,
			trustRootPath,
			error: `write: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return { changed: true, trustRootPath };
}

function normalizeTerminalText(input: string): string {
	return input.toLowerCase().replace(/\s+/gu, " ");
}

function stripAnsiAndControl(input: string): string {
	let output = "";
	let mode: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
	for (const char of input) {
		if (mode === "text") {
			if (char === "\u001b") {
				mode = "escape";
				continue;
			}
			const code = char.charCodeAt(0);
			if ((code >= 32 && code !== 127) || char === "\n" || char === "\r" || char === "\t") {
				output += char;
			}
			continue;
		}
		if (mode === "escape") {
			if (char === "[") {
				mode = "csi";
				continue;
			}
			if (char === "]") {
				mode = "osc";
				continue;
			}
			mode = "text";
			continue;
		}
		if (mode === "csi") {
			const code = char.charCodeAt(0);
			if (code >= 64 && code <= 126) {
				mode = "text";
			}
			continue;
		}
		if (mode === "osc") {
			if (char === "\u0007") {
				mode = "text";
			} else if (char === "\u001b") {
				mode = "osc_escape";
			}
			continue;
		}
		if (mode === "osc_escape") {
			mode = char === "\\" ? "text" : "osc";
		}
	}
	return output;
}

export function hasCodexWorkspaceTrustPrompt(text: string): boolean {
	const rawNormalized = normalizeTerminalText(text);
	if (hasOrderedTokens(rawNormalized, CODEX_WORKSPACE_TRUST_TOKENS)) {
		return true;
	}
	const strippedNormalized = normalizeTerminalText(stripAnsiAndControl(text));
	return hasOrderedTokens(strippedNormalized, CODEX_WORKSPACE_TRUST_TOKENS);
}

function hasOrderedTokens(input: string, tokens: readonly string[]): boolean {
	let index = 0;
	for (const token of tokens) {
		const found = input.indexOf(token, index);
		if (found === -1) {
			return false;
		}
		index = found + token.length;
	}
	return true;
}

export function shouldAutoConfirmCodexWorkspaceTrust(agentId: RuntimeAgentId, cwd: string): boolean {
	void cwd;
	return agentId === "codex";
}
