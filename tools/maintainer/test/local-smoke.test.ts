import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { maintenanceConfigSchema, type WorkerResult } from "../src/contracts";
import { verifyExactCommitLocalSmoke } from "../src/local-smoke";
import type { CommandRunner } from "../src/ports";

const commit = "b".repeat(40),
	image = "c".repeat(64);
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "maintainer-exact-smoke-test-"));
	roots.push(root);
	await mkdir(join(root, "dist"));
	const config = maintenanceConfigSchema.parse({
		version: 1,
		repository: "example/project",
		branch: "main",
		projectDirectory: root,
		sessionId: "ses_fixture",
		opencodeCli: "/fixture/opencode",
		githubBridge: { executable: "/fixture/bridge", args: [] },
		timezone: "UTC",
		requiredWorkflows: ["checks.yml"],
		localSmoke: { imageId: image },
	});
	const result: WorkerResult = {
		version: 1,
		jobId: `maint-${"a".repeat(32)}`,
		startingCommit: "a".repeat(40),
		issues: [{ number: 1, disposition: "fixed", commits: [commit] }],
	};
	let dirty = false,
		head = commit,
		changed = false;
	const cli = "Fixture compiled bytes";
	const run = vi.fn<CommandRunner>(async (input) => {
		let stdout = "";
		if (input.executable === "git")
			stdout =
				input.args[0] === "status"
					? dirty
						? " M src/owned.ts\n"
						: ""
					: input.args[0] === "branch"
						? "main\n"
						: `${head}\n`;
		else if (input.executable === "npm") {
			if (input.args[0] === "run") {
				const cwd = input.cwd ?? root;
				await mkdir(join(cwd, "dist"), { recursive: true });
				await writeFile(join(cwd, "dist", "cli.js"), cli);
				await writeFile(join(cwd, "dist", "ui.js"), "Compiled UI bytes");
			}
		} else if (input.executable === "tar") {
			stdout = "";
		} else if (input.executable === "podman") stdout = image;
		else {
			stdout = JSON.stringify({
				status: "passed",
				imageId: image,
				productBundleSha256: createHash("sha256").update(cli).digest("hex"),
				ownedPodCleanupComplete: true,
				noProviderTurns: true,
				noLiveDataMounted: true,
			});
			if (changed) await writeFile(join(input.args[2] ?? root, "dist", "ui.js"), "Different untested UI");
		}
		return { status: 0, stdout, stderr: "" };
	});
	return {
		root,
		config,
		result,
		run,
		dirty: () => {
			dirty = true;
		},
		head: (value: string) => {
			head = value;
		},
		changed: () => {
			changed = true;
		},
	};
}
describe("independent exact-source local pod smoke gate", () => {
	it("rebuilds clean reported source and independently binds all artifact bytes, image and verified cleanup before accepting evidence", async () => {
		const f = await fixture();
		const proof = await verifyExactCommitLocalSmoke(f.config, f.result, f.run);
		expect(proof).toMatchObject({
			commit,
			imageId: image,
			passed: true,
			scope: "exact_commit_local_overlay",
			ownedPodCleanupComplete: true,
		});
		expect(proof.productAssetsSha256).toMatch(/^[a-f0-9]{64}$/u);
		const build = f.run.mock.calls.find(([input]) => input.executable === "npm" && input.args[0] === "run")?.[0];
		expect(build?.env?.HOME).not.toBe(process.env.HOME);
		expect(Object.keys(build?.env ?? {}).sort()).toEqual(["CI", "HOME", "LANG", "PATH", "TMPDIR"]);
		if (!build?.env?.HOME) throw new Error("No isolated build home");
		await expect(readdir(build.env.HOME)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("refuses dirty or unreported source before any build/pod command, without replacing user changes", async () => {
		for (const change of ["dirty", "wrong-head"] as const) {
			const f = await fixture();
			if (change === "dirty") f.dirty();
			else f.head("e".repeat(40));
			await expect(verifyExactCommitLocalSmoke(f.config, f.result, f.run)).rejects.toThrow(
				change === "dirty" ? "dirty checkout" : "not a reported",
			);
			expect(f.run.mock.calls.some(([input]) => input.executable === "npm" || input.executable === "podman")).toBe(
				false,
			);
		}
	});
	it("does not accept CLI-only evidence when UI/artifact bytes change during the local smoke run", async () => {
		const f = await fixture();
		f.changed();
		await expect(verifyExactCommitLocalSmoke(f.config, f.result, f.run)).rejects.toThrow("artifact changed");
	});
	it("missing operator image configuration does not launch anything or use a mutable-tag fallback", async () => {
		const f = await fixture();
		const { localSmoke: _absent, ...config } = f.config;
		await expect(verifyExactCommitLocalSmoke(config, f.result, f.run)).rejects.toThrow("not configured");
		expect(f.run).not.toHaveBeenCalled();
	});
});
