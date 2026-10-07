import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";

// Sourcemap upload targets the fork's own Sentry org/projects; nothing is uploaded unless all are configured.
const SENTRY_ORG = process.env.SENTRY_ORG?.trim();
const SENTRY_WEB_PROJECT = process.env.SENTRY_WEB_PROJECT?.trim();
const SENTRY_NODE_PROJECT = process.env.SENTRY_NODE_PROJECT?.trim();

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const distDir = resolve(repoRoot, "dist");
const webDistDir = resolve(distDir, "web-ui");
const stagingRoot = resolve(repoRoot, ".sentry-artifacts");
const nodeStagingDir = resolve(stagingRoot, "node");
const sentryCliBinary = resolve(
	repoRoot,
	"node_modules",
	".bin",
	process.platform === "win32" ? "sentry-cli.exe" : "sentry-cli",
);

function runSentryCli(args) {
	const result = spawnSync(sentryCliBinary, args, {
		cwd: repoRoot,
		env: process.env,
		stdio: "inherit",
	});

	if (result.status !== 0) {
		const signalMessage = result.signal ? ` (signal: ${result.signal})` : "";
		throw new Error(`sentry-cli ${args.join(" ")} failed${signalMessage}`);
	}
}

function shouldCopyToNodeStaging(sourcePath) {
	const pathFromDist = relative(distDir, sourcePath);
	if (!pathFromDist) {
		return true;
	}
	if (pathFromDist === "web-ui") {
		return false;
	}
	return !pathFromDist.startsWith(`web-ui${sep}`);
}

async function main() {
	const requiredEnv = {
		SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN?.trim(),
		SENTRY_ORG,
		SENTRY_WEB_PROJECT,
		SENTRY_NODE_PROJECT,
	};
	const missingEnv = Object.keys(requiredEnv).filter((name) => !requiredEnv[name]);
	if (missingEnv.length > 0) {
		console.log(`Skipping Sentry sourcemap upload; not set: ${missingEnv.join(", ")}.`);
		return;
	}

	await rm(stagingRoot, { force: true, recursive: true });
	await mkdir(stagingRoot, { recursive: true });

	runSentryCli(["sourcemaps", "inject", distDir]);

	await cp(distDir, nodeStagingDir, {
		filter: shouldCopyToNodeStaging,
		recursive: true,
	});

	runSentryCli(["sourcemaps", "upload", "--org", SENTRY_ORG, "--project", SENTRY_WEB_PROJECT, webDistDir]);
	runSentryCli(["sourcemaps", "upload", "--org", SENTRY_ORG, "--project", SENTRY_NODE_PROJECT, nodeStagingDir]);

	await rm(stagingRoot, { force: true, recursive: true });
}

main().catch(async (error) => {
	await rm(stagingRoot, { force: true, recursive: true });
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to upload Sentry sourcemaps: ${message}`);
	process.exit(1);
});
