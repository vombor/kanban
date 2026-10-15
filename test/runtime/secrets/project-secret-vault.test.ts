import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createProjectSecretVault } from "../../../src/secrets/project-secret-vault";
import { createProjectSecretsApi } from "../../../src/secrets/project-secrets-api";
import { getProjectSecretsPath } from "../../../src/state/kanban-home";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createTempDir } from "../../utilities/temp-dir";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup() {
	const temp = createTempDir("kanban-secret-vault-");
	cleanups.push(temp.cleanup);
	const options = { homePath: temp.path, now: () => new Date("2026-10-14T08:00:00Z") };
	return {
		home: temp.path,
		vault: createProjectSecretVault(options),
		reopen: () => createProjectSecretVault(options),
	};
}
function session(workspaceId: string): RuntimeCaller {
	return {
		kind: "session",
		via: "credential",
		session: { workspaceId, taskId: "abcde", role: "card", agentId: "claude", cwd: `/projects/${workspaceId}` },
	};
}
describe("project secret vault", () => {
	it("persists only ciphertext and metadata, reopens, rotates and removes values", async () => {
		const { home, vault, reopen } = setup();
		const metadata = await vault.set("alpha", [{ name: "DATABASE_URL", value: "private-db-value" }]);
		expect(metadata).toEqual([{ name: "DATABASE_URL", configured: true, updatedAt: "2026-10-14T08:00:00.000Z" }]);
		const text = await readFile(getProjectSecretsPath("alpha", home), "utf8");
		expect(text).not.toContain("private-db-value");
		expect((await stat(getProjectSecretsPath("alpha", home))).mode & 0o777).toBe(0o600);
		expect((await stat(join(home, "secrets", "project-vault-key"))).mode & 0o777).toBe(0o600);
		expect((await stat(join(home, "secrets"))).mode & 0o777).toBe(0o700);
		let observed: Readonly<Record<string, string>> | undefined;
		await reopen().withValues("alpha", ["DATABASE_URL"], async (values) => {
			observed = values;
			expect(values.DATABASE_URL).toBe("private-db-value");
		});
		expect(observed).toEqual({});
		await vault.set("alpha", [{ name: "DATABASE_URL", value: "rotated-value" }]);
		await reopen().withValues("alpha", ["DATABASE_URL"], async (values) => {
			expect(values.DATABASE_URL).toBe("rotated-value");
		});
		expect(await vault.remove("alpha", "DATABASE_URL")).toEqual([]);
		await expect(vault.withValues("alpha", ["DATABASE_URL"], async () => {})).rejects.toThrow("not configured");
	});
	it("keeps concurrent project writes and binds ciphertext to its project", async () => {
		const { home, vault, reopen } = setup();
		await Promise.all([
			vault.set("alpha", [{ name: "ONE", value: "first" }]),
			reopen().set("alpha", [{ name: "TWO", value: "second" }]),
			reopen().set("beta", [{ name: "ONE", value: "different" }]),
		]);
		expect((await vault.list("alpha")).map((secret) => secret.name)).toEqual(["ONE", "TWO"]);
		await writeFile(getProjectSecretsPath("beta", home), await readFile(getProjectSecretsPath("alpha", home)));
		await expect(reopen().withValues("beta", ["ONE"], async () => {})).rejects.toThrow("encrypted secret vault");
		const copied = JSON.parse(await readFile(getProjectSecretsPath("beta", home), "utf8")) as Record<string, unknown>;
		copied.scope = "beta";
		await writeFile(getProjectSecretsPath("beta", home), JSON.stringify(copied));
		await expect(reopen().withValues("beta", ["ONE"], async () => {})).rejects.toThrow("Could not decrypt");
	});
	it("does not overwrite corrupt data, regenerate a missing key, or expose consumer exceptions", async () => {
		const { home, vault, reopen } = setup();
		await vault.set("alpha", [{ name: "KEY", value: "private-sentinel" }]);
		await expect(
			vault.withValues("alpha", ["KEY"], async (values) => {
				throw new Error(values.KEY);
			}),
		).rejects.toThrow("Project secret consumer failed");
		await rm(join(home, "secrets", "project-vault-key"));
		await expect(reopen().set("alpha", [{ name: "KEY", value: "new" }])).rejects.toThrow("key is missing");
		await writeFile(getProjectSecretsPath("alpha", home), "broken-json");
		await expect(reopen().set("alpha", [{ name: "KEY", value: "new" }])).rejects.toThrow("encrypted secret vault");
		expect(await readFile(getProjectSecretsPath("alpha", home), "utf8")).toBe("broken-json");
	});
	it("does not replace a missing key when another project still has encrypted records", async () => {
		const { home, vault, reopen } = setup();
		await vault.set("alpha", [{ name: "KEY", value: "private-sentinel" }]);
		const keyPath = join(home, "secrets", "project-vault-key");
		const originalKey = await readFile(keyPath);
		await rm(keyPath);
		await expect(reopen().set("beta", [{ name: "KEY", value: "new-value" }])).rejects.toThrow("key is missing");
		await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await reopen().list("beta")).toEqual([]);
		await writeFile(keyPath, originalKey, { mode: 0o600 });
		await reopen().withValues("alpha", ["KEY"], async (values) => {
			expect(values.KEY).toBe("private-sentinel");
		});
	});
	it("creates a first key alongside empty vaults but refuses damaged vaults in another project", async () => {
		const { home, vault, reopen } = setup();
		await vault.remove("empty", "UNSET");
		await reopen().set("alpha", [{ name: "KEY", value: "private-sentinel" }]);
		const keyPath = join(home, "secrets", "project-vault-key");
		await rm(keyPath);
		await writeFile(getProjectSecretsPath("alpha", home), "broken-json");
		await expect(reopen().set("beta", [{ name: "KEY", value: "new-value" }])).rejects.toThrow(
			"Could not inspect existing project secret vaults",
		);
		await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(getProjectSecretsPath("alpha", home), "utf8")).toBe("broken-json");
	});
	it("rejects path escapes, duplicate names and unsafe object keys before writing", async () => {
		const { vault } = setup();
		for (const scope of ["../escape", ".", "", "nested/project"])
			await expect(vault.set(scope, [{ name: "KEY", value: "value" }])).rejects.toThrow();
		for (const name of ["bad-name", "__proto__", "constructor"])
			await expect(vault.set("alpha", [{ name, value: "value" }])).rejects.toThrow();
		await expect(
			vault.set("alpha", [
				{ name: "KEY", value: "first" },
				{ name: "KEY", value: "second" },
			]),
		).rejects.toThrow("unique");
		expect(await vault.list("alpha")).toEqual([]);
	});
	it("rebinds moved project secrets idempotently while preserving metadata", async () => {
		const { home, vault, reopen } = setup();
		const prior = await vault.set("alpha", [{ name: "KEY", value: "private-sentinel" }]);
		await rename(join(home, "data", "alpha"), join(home, "data", "renamed"));
		await reopen().rebind("alpha", "renamed");
		await reopen().rebind("alpha", "renamed");
		expect(await reopen().list("renamed")).toEqual(prior);
		await reopen().withValues("renamed", ["KEY"], async (values) => {
			expect(values.KEY).toBe("private-sentinel");
		});
	});
	it("returns metadata to only the user/own project and permits only user writes", async () => {
		const { vault } = setup();
		const api = createProjectSecretsApi(vault);
		const input = { workspaceId: "alpha", secrets: [{ name: "KEY", value: "private-sentinel" }] };
		for (const caller of [session("alpha"), session("beta"), { kind: "unknown", reason: "unknown" } as const]) {
			await expect(api.set({ ...input, caller })).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(api.remove({ workspaceId: "alpha", name: "KEY", caller })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
		const result = await api.set({ ...input, caller: { kind: "user" } });
		expect(JSON.stringify(result)).not.toContain("private-sentinel");
		expect(await api.list({ workspaceId: "alpha", caller: session("alpha") })).toEqual(result);
		await expect(api.list({ workspaceId: "alpha", caller: session("beta") })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("uses strict caller identity on the RPC even when the ordinary caller looks like the user", async () => {
		const { vault } = setup();
		const caller = runtimeAppRouter.createCaller({
			requestedWorkspaceId: "alpha",
			workspaceScope: { workspaceId: "alpha", workspacePath: "/projects/alpha" },
			getCaller: async () => ({ kind: "user" }),
			resolveStrictCaller: async () => session("alpha"),
			projectSecretsApi: createProjectSecretsApi(vault),
		} as unknown as RuntimeTrpcContext);
		await expect(
			caller.projectSecrets.set({ secrets: [{ name: "KEY", value: "private-sentinel" }] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await caller.projectSecrets.list()).toEqual({ secrets: [] });
	});
});
