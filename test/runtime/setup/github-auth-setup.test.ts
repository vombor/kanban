import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGitHubConfigDir, planGitHubGitAuth } from "../../../src/setup/github-auth-setup";
import { getMachineSetupPaths, planNpmrc } from "../../../src/setup/machine-setup";
import { createTempDir } from "../../utilities/temp-dir";

const temps: ReturnType<typeof createTempDir>[] = [];
afterEach(() => {
	for (const temp of temps.splice(0)) temp.cleanup();
});

describe("explicit GitHub instance setup", () => {
	it("refreshes managed token-variable references but never changes a user's own auth value", async () => {
		const temp = createTempDir("kanban-npm-reference-");
		temps.push(temp);
		const paths = getMachineSetupPaths({ HOME: temp.path });
		writeFileSync(
			paths.npmrc,
			`loglevel=warn\nupdate-notifier=false\nfund=false\n@vombor:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=\${GITHUB_TOKEN}\n`,
		);
		const plan = await planNpmrc(paths, { GH_TOKEN: "fixture-token" });
		expect(plan.status).toBe("change");
		await plan.apply?.();
		expect(readFileSync(paths.npmrc, "utf8")).toContain(`:_authToken=\${GH_TOKEN}`);
		const own = readFileSync(paths.npmrc, "utf8").replace(`\${GH_TOKEN}`, `\${MY_OWN_TOKEN}`);
		writeFileSync(paths.npmrc, own);
		expect((await planNpmrc(paths, { GH_TOKEN: "fixture-token" })).status).toBe("ok");
		expect(readFileSync(paths.npmrc, "utf8")).toBe(own);
	});
	it("plans npm references without secrets, preserves user keys, and writes privately only on apply", async () => {
		const temp = createTempDir("kanban-github-setup-");
		temps.push(temp);
		const env = { HOME: temp.path, GH_TOKEN: "fixture-value-never-written" };
		const paths = getMachineSetupPaths(env);
		writeFileSync(paths.npmrc, "save-exact=true\n@vombor:registry=https://private.test/\n");
		const original = readFileSync(paths.npmrc, "utf8");
		const plan = await planNpmrc(paths, env);
		expect(plan.status).toBe("change");
		expect(readFileSync(paths.npmrc, "utf8")).toBe(original);
		expect(JSON.stringify(plan)).not.toContain(env.GH_TOKEN);
		await plan.apply?.();
		const written = readFileSync(paths.npmrc, "utf8");
		expect(written).toContain("@vombor:registry=https://private.test/");
		expect(written).toContain(`//npm.pkg.github.com/:_authToken=\${GH_TOKEN}`);
		expect(written).not.toContain(env.GH_TOKEN);
		expect((await planNpmrc(paths, env)).status).toBe("ok");
		const privatePaths = getMachineSetupPaths({
			HOME: temp.path,
			NPM_CONFIG_USERCONFIG: join(temp.path, "new.npmrc"),
		});
		await (await planNpmrc(privatePaths, env)).apply?.();
		expect(statSync(privatePaths.npmrc).mode & 0o777).toBe(0o600);
	});

	it("honors tool-specific directories and never relocates user tools under KANBAN_HOME", () => {
		expect(getMachineSetupPaths({ HOME: "/home/example", KANBAN_HOME: "/srv/board" }).npmrc).toBe(
			"/home/example/.npmrc",
		);
		expect(getMachineSetupPaths({ npm_config_userconfig: "/srv/npmrc" }).npmrc).toBe("/srv/npmrc");
		expect(getGitHubConfigDir({ HOME: "/home/example" })).toBe("/home/example/.config/gh");
		expect(getGitHubConfigDir({ HOME: "/home/example", XDG_CONFIG_HOME: "/srv/config" })).toBe("/srv/config/gh");
		expect(getGitHubConfigDir({ GH_CONFIG_DIR: "/srv/gh", XDG_CONFIG_HOME: "/ignored" })).toBe("/srv/gh");
	});

	it("plans git bootstrap read-only and keeps a helper the user adds before apply", async () => {
		const readHelpers = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(["user-helper"]);
		const setup = vi.fn(async () => {});
		const plan = await planGitHubGitAuth({ GH_TOKEN: "fixture-token" }, { isOnPath: () => true, readHelpers, setup });
		expect(plan.status).toBe("change");
		expect(setup).not.toHaveBeenCalled();
		await plan.apply?.();
		expect(setup).not.toHaveBeenCalled();
	});

	it("configures a missing helper only on explicit apply, with no network or host git writes in tests", async () => {
		const setup = vi.fn(async () => {});
		const deps = { isOnPath: () => true, readHelpers: async () => [], setup };
		const plan = await planGitHubGitAuth({ GITHUB_TOKEN: "fixture-token" }, deps);
		await plan.apply?.();
		expect(setup).toHaveBeenCalledOnce();
		expect((await planGitHubGitAuth({}, deps)).status).toBe("skipped");
	});
});
