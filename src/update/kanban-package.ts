import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The fork publishes to GitHub Packages, which only takes packages scoped to the repo owner. Keep these equal to
// package.json's `name` and `publishConfig.registry` (test/runtime/update/kanban-package.test.ts checks it).
export const KANBAN_PACKAGE_NAME = "@vombor/kanban";
export const KANBAN_PACKAGE_REGISTRY = "https://npm.pkg.github.com";
const KANBAN_PACKAGE_SCOPE = "@vombor";

/**
 * npm flags that send a package's scope to Kanban's registry, so an install never depends on an `@vombor:registry`
 * line in the user's .npmrc (without one npm asks registry.npmjs.org, where anyone could own the scope). Verified
 * with npm 11 and npx (`npm view --@vombor:registry=https://npm.pkg.github.com @vombor/kanban` asks
 * npm.pkg.github.com). Empty for a package outside the scope.
 */
export function buildScopeRegistryArgs(packageName: string): string[] {
	return packageName.startsWith(`${KANBAN_PACKAGE_SCOPE}/`)
		? [`--${KANBAN_PACKAGE_SCOPE}:registry=${KANBAN_PACKAGE_REGISTRY}`]
		: [];
}

export interface RegistryAuthTokenOptions {
	registry?: string;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	readTextFile?: (path: string) => string;
}

function expandNpmrcEnv(value: string, env: NodeJS.ProcessEnv): string {
	// npm expands `${NAME}` (and `${NAME?}`, which allows an unset variable) in .npmrc values.
	return value.replace(/\$\{([^}?]+)\??\}/gu, (_match, name: string) => env[name] ?? "");
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'")) && trimmed.endsWith(trimmed[0])) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** `//npm.pkg.github.com/` for `https://npm.pkg.github.com`, the key prefix npm uses for per-registry auth. */
function toNpmrcRegistryKey(registry: string): string {
	const withoutProtocol = registry.replace(/^[a-z]+:/iu, "");
	return withoutProtocol.endsWith("/") ? withoutProtocol : `${withoutProtocol}/`;
}

export function readNpmrcAuthToken(content: string, registry: string, env: NodeJS.ProcessEnv): string | null {
	const key = `${toNpmrcRegistryKey(registry)}:_authToken`;
	for (const rawLine of content.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
			continue;
		}
		const separator = line.indexOf("=");
		if (separator < 0 || line.slice(0, separator).trim() !== key) {
			continue;
		}
		const token = expandNpmrcEnv(unquote(line.slice(separator + 1)), env).trim();
		if (token.length > 0) {
			return token;
		}
	}
	return null;
}

/**
 * The token npm itself would send to the registry: the `_authToken` for it in the user's .npmrc, else
 * `NODE_AUTH_TOKEN` (setup-node), `GH_TOKEN` (the container's PAT) or `GITHUB_TOKEN`. GitHub Packages answers
 * nothing without one, even for a public package. The token is only ever put in a request header; never print or
 * log it.
 */
export function resolveRegistryAuthToken(options: RegistryAuthTokenOptions = {}): string | null {
	const env = options.env ?? process.env;
	const registry = options.registry ?? KANBAN_PACKAGE_REGISTRY;
	const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
	const npmrcPath =
		env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig || join(options.homeDir ?? homedir(), ".npmrc");
	try {
		const token = readNpmrcAuthToken(readTextFile(npmrcPath), registry, env);
		if (token) {
			return token;
		}
	} catch {
		// No readable .npmrc: fall through to the env.
	}
	const envToken = env.NODE_AUTH_TOKEN?.trim() || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
	return envToken || null;
}

/** Registry URL of a package's metadata document; the scope's slash is encoded, as npm does. */
export function buildPackumentUrl(registry: string, packageName: string): string {
	return `${registry.replace(/\/+$/u, "")}/${packageName.replace("/", "%2f")}`;
}
