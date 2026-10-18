import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	commitShaSchema,
	type LocalSmokeProof,
	localSmokeProofSchema,
	type MaintenanceConfig,
	type WorkerResult,
} from "./contracts";
import type { CommandRunner } from "./ports";

async function artifactDigest(root: string): Promise<string> {
	const hash = createHash("sha256");
	const scan = async (dir: string, prefix: string): Promise<void> => {
		for (const name of (await readdir(dir)).sort()) {
			const file = join(dir, name),
				info = await lstat(file);
			if (info.isSymbolicLink()) throw new Error("Smoke artifacts cannot be symlinks");
			if (info.isDirectory()) await scan(file, `${prefix}${name}/`);
			else if (info.isFile()) {
				hash.update(`${prefix}${name}\0`);
				hash.update(
					createHash("sha256")
						.update(await readFile(file))
						.digest(),
				);
			} else throw new Error("Unusable smoke artifact");
		}
	};
	await scan(root, "");
	return hash.digest("hex");
}
/** Independent host verifier. A worker's report/digest is never local-smoke evidence. No live update or credential fallback. */
export async function verifyExactCommitLocalSmoke(
	config: MaintenanceConfig,
	result: WorkerResult,
	run: CommandRunner,
): Promise<LocalSmokeProof> {
	if (!config.localSmoke) throw new Error("Operator-owned immutable local smoke image is not configured.");
	const command = async (executable: string, args: string[], extra: Partial<Parameters<CommandRunner>[0]> = {}) => {
		const response = await run({ executable, args, cwd: config.projectDirectory, ...extra });
		if (response.status !== 0)
			throw new Error("Independent local smoke prerequisite/check failed; no source or acceptance was replaced.");
		return response.stdout;
	};
	const source = async () => {
		if ((await command("git", ["status", "--porcelain=v1", "--untracked-files=all"])).trim())
			throw new Error("Exact-commit smoke refuses a dirty checkout; preserve existing user work.");
		if ((await command("git", ["branch", "--show-current"])).trim() !== config.branch)
			throw new Error("Smoke branch differs from the admitted source.");
		return commitShaSchema.parse((await command("git", ["rev-parse", "HEAD"])).trim());
	};
	const commit = await source();
	if (!result.issues.some((issue) => issue.disposition === "fixed" && issue.commits.includes(commit)))
		throw new Error("Smoke HEAD is not a reported, independently verified fix commit.");
	await command("podman", ["image", "inspect", config.localSmoke.imageId, "--format", "{{.Id}}"]);
	const home = await mkdtemp(join(tmpdir(), "kanban-maintainer-smoke-build-"));
	try {
		const exported = join(home, "source"),
			userHome = join(home, "user-home");
		await mkdir(exported);
		await mkdir(userHome);
		const env = { PATH: process.env.PATH, HOME: userHome, TMPDIR: home, LANG: process.env.LANG, CI: "1" };
		// Exact committed export prevents ignored local .env/config/artifacts from being relabelled as committed source.
		await command("git", ["archive", "--format=tar", `--output=${join(home, "source.tar")}`, commit]);
		await command(
			"tar",
			["--extract", "--no-same-owner", "--file", join(home, "source.tar"), "--directory", exported],
			{ env },
		);
		for (const args of [
			["ci", "--ignore-scripts", "--no-audit", "--fund=false"],
			["ci", "--prefix", "web-ui", "--ignore-scripts", "--no-audit", "--fund=false"],
		])
			await command("npm", args, { cwd: exported, env, timeoutMs: 300_000 });
		// No install hooks, inherited credentials, live Kanban paths, updater or sourcemap upload.
		await command("npm", ["run", "build", "--ignore-scripts"], {
			cwd: exported,
			timeoutMs: 300_000,
			env,
		});
		if ((await source()) !== commit)
			throw new Error("Smoke source changed during build; no completion was recorded.");
		const product = join(exported, "dist"),
			productAssetsSha256 = await artifactDigest(product);
		const productBundleSha256 = createHash("sha256")
			.update(await readFile(join(product, "cli.js")))
			.digest("hex");
		const raw = await command(
			process.execPath,
			[join(exported, "tools/maintainer/local-pod-smoke.mjs"), config.localSmoke.imageId, exported],
			{ timeoutMs: 300_000, maxBytes: 128 * 1024 },
		);
		const proof = z
			.object({
				status: z.literal("passed"),
				imageId: z.literal(config.localSmoke.imageId),
				productBundleSha256: z.literal(productBundleSha256),
				ownedPodCleanupComplete: z.literal(true),
				noProviderTurns: z.literal(true),
				noLiveDataMounted: z.literal(true),
			})
			.parse(JSON.parse(raw.trim()));
		if ((await source()) !== commit || (await artifactDigest(product)) !== productAssetsSha256)
			throw new Error("Smoke source/artifact changed during execution; retained reports do not prove this commit.");
		return localSmokeProofSchema.parse({
			version: 1,
			commit,
			imageId: proof.imageId,
			productBundleSha256,
			productAssetsSha256,
			passed: true,
			ownedPodCleanupComplete: true,
			noProviderTurns: true,
			noLiveDataMounted: true,
			scope: "exact_commit_local_overlay",
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}
