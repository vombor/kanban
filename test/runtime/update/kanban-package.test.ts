import { describe, expect, it, vi } from "vitest";

import packageJson from "../../../package.json" with { type: "json" };
import {
	buildPackumentUrl,
	KANBAN_PACKAGE_NAME,
	KANBAN_PACKAGE_REGISTRY,
	readNpmrcAuthToken,
	resolveRegistryAuthToken,
} from "../../../src/update/kanban-package";
import {
	clearPendingUpdateNotification,
	detectAutoUpdateInstallation,
	fetchLatestVersionFromRegistry,
	getPendingUpdateNotification,
	runAutoUpdateCheck,
	runOnDemandUpdate,
	UpdatePackageManager,
} from "../../../src/update/update";

const REGISTRY_FLAG = "--@vombor:registry=https://npm.pkg.github.com";

describe("Kanban's package on GitHub Packages", () => {
	it("matches package.json's name and publish registry", () => {
		expect(packageJson.name).toBe(KANBAN_PACKAGE_NAME);
		expect(packageJson.publishConfig.registry).toBe(KANBAN_PACKAGE_REGISTRY);
		expect(packageJson.bin).toEqual({ kanban: "dist/cli.js" });
	});

	it("encodes the scope's slash in the metadata URL", () => {
		expect(buildPackumentUrl("https://npm.pkg.github.com/", "@vombor/kanban")).toBe(
			"https://npm.pkg.github.com/@vombor%2fkanban",
		);
	});

	it("checks prerelease (fork) versions against the next dist-tag and releases against latest", () => {
		const entrypointPath = "/usr/local/lib/node_modules/@vombor/kanban/dist/cli.js";
		const fork = detectAutoUpdateInstallation({
			currentVersion: "0.1.70-fork.5",
			packageName: KANBAN_PACKAGE_NAME,
			entrypointPath,
			cwd: "/projects",
		});
		expect(fork.npmTag).toBe("next");
		expect(fork.updateCommand).toEqual({
			command: "npm",
			args: ["install", "-g", REGISTRY_FLAG, "@vombor/kanban@next"],
		});
		const release = detectAutoUpdateInstallation({
			currentVersion: "0.2.0",
			packageName: KANBAN_PACKAGE_NAME,
			entrypointPath,
			cwd: "/projects",
		});
		expect(release.npmTag).toBe("latest");
	});
});

describe("update commands for the scoped package", () => {
	it("send the scope to GitHub Packages in the npm install and the shown command, never via npmjs", async () => {
		const spawned: string[][] = [];
		clearPendingUpdateNotification();
		await runAutoUpdateCheck({
			currentVersion: "0.1.70-fork.5",
			argv: ["node", "/usr/local/lib/node_modules/@vombor/kanban/dist/cli.js"],
			cwd: "/projects",
			env: {},
			resolveRealPath: (path) => path,
			fetchLatestVersion: async () => "0.1.70-fork.6",
			spawnUpdate: (command, args) => spawned.push([command, ...args]),
		});
		expect(spawned).toEqual([["npm", "install", "-g", REGISTRY_FLAG, "@vombor/kanban@next"]]);
		expect(getPendingUpdateNotification()?.installCommand).toBe(
			`npm install -g ${REGISTRY_FLAG} @vombor/kanban@next`,
		);
		clearPendingUpdateNotification();
	});

	it("re-runs npx with the flag", async () => {
		clearPendingUpdateNotification();
		await runAutoUpdateCheck({
			currentVersion: "0.1.70-fork.5",
			argv: ["node", "/root/.npm/_npx/593b71878a7c70f2/node_modules/@vombor/kanban/dist/cli.js"],
			cwd: "/projects",
			env: {},
			resolveRealPath: (path) => path,
			fetchLatestVersion: async () => "0.1.70-fork.6",
			scheduleShutdownUpdate: () => {},
		});
		expect(getPendingUpdateNotification()?.installCommand).toBe(`npx ${REGISTRY_FLAG} @vombor/kanban`);
		clearPendingUpdateNotification();
	});

	it.each([
		["pnpm", "/root/.local/share/pnpm/global/5/node_modules/@vombor/kanban/dist/cli.js", UpdatePackageManager.PNPM],
		["yarn", "/root/.config/yarn/global/node_modules/@vombor/kanban/dist/cli.js", UpdatePackageManager.YARN],
		["bun", "/root/.bun/bin/node_modules/@vombor/kanban/dist/cli.js", UpdatePackageManager.BUN],
	])("offers no %s update (its scope flag isn't verified)", async (_name, entrypointPath, packageManager) => {
		const installation = detectAutoUpdateInstallation({
			currentVersion: "0.1.70-fork.5",
			packageName: KANBAN_PACKAGE_NAME,
			entrypointPath,
			cwd: "/projects",
		});
		expect(installation.packageManager).toBe(packageManager);
		expect(installation.updateCommand).toBeNull();
	});

	it("passes the flag to the manual update of a local checkout", async () => {
		const ran: string[][] = [];
		const result = await runOnDemandUpdate({
			currentVersion: "0.1.70-fork.5",
			argv: ["node", "/projects/kanban/dist/cli.js"],
			cwd: "/projects/kanban",
			resolveRealPath: (path) => path,
			fetchLatestVersion: async () => "0.1.70-fork.6",
			runUpdateCommand: (command, args) => {
				ran.push([command, ...args]);
				return 0;
			},
		});
		expect(result.status).toBe("updated");
		expect(ran).toEqual([["npm", "install", "-g", REGISTRY_FLAG, "@vombor/kanban@next"]]);
	});
});

describe("registry auth token", () => {
	it("reads the registry's _authToken from .npmrc and expands $VAR references from the env", () => {
		const npmrc = [
			"@vombor:registry=https://npm.pkg.github.com",
			"//registry.npmjs.org/:_authToken=other",
			`//npm.pkg.github.com/:_authToken=\${GH_TOKEN}`,
		].join("\n");
		expect(readNpmrcAuthToken(npmrc, "https://npm.pkg.github.com", { GH_TOKEN: "pat" })).toBe("pat");
		expect(readNpmrcAuthToken(npmrc, "https://npm.pkg.github.com", {})).toBeNull();
	});

	it("falls back to the env, and is null without any token", () => {
		const noFile = () => {
			throw new Error("ENOENT");
		};
		expect(resolveRegistryAuthToken({ env: { GH_TOKEN: "pat" }, homeDir: "/nowhere", readTextFile: noFile })).toBe(
			"pat",
		);
		expect(resolveRegistryAuthToken({ env: {}, homeDir: "/nowhere", readTextFile: noFile })).toBeNull();
	});
});

describe("fetchLatestVersionFromRegistry", () => {
	it("sends no request without a token", async () => {
		const fetchImpl = vi.fn();
		const version = await fetchLatestVersionFromRegistry(
			{ packageName: KANBAN_PACKAGE_NAME, npmTag: "next" },
			{ resolveAuthToken: () => null, fetchImpl },
		);
		expect(version).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("reads the dist-tag from the package metadata with the token as a bearer header", async () => {
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ "dist-tags": { latest: "0.1.70", next: "0.1.70-fork.6" } }), { status: 200 }),
		);
		const version = await fetchLatestVersionFromRegistry(
			{ packageName: KANBAN_PACKAGE_NAME, npmTag: "next" },
			{ resolveAuthToken: () => "pat", fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(version).toBe("0.1.70-fork.6");
		expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://npm.pkg.github.com/@vombor%2fkanban");
		expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer pat");
	});

	it("finds nothing when the registry refuses the token", async () => {
		const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
		const version = await fetchLatestVersionFromRegistry(
			{ packageName: KANBAN_PACKAGE_NAME, npmTag: "latest" },
			{ resolveAuthToken: () => "bad", fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(version).toBeNull();
	});
});
