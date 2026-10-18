// Operator-owned local smoke pod. Read-only product overlay only; no live home/project/credentials or browser.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { PRODUCT_SMOKE_PROBE } from "../../scripts/product-smoke-probe.mjs";

const [image, checkout = process.cwd()] = process.argv.slice(2);
if (!image || !/^[a-f0-9]{64}$/u.test(image))
	throw new Error("Supply a locally inspected, immutable Podman image id—not a mutable tag.");
const root = await realpath(checkout);
const product = join(root, "dist");
const packagePath = join(root, "package.json");
const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
if (packageMetadata.name !== "@vombor/kanban" || Object.keys(packageMetadata.bin).join() !== "kanban")
	throw new Error("Product manifest still exposes maintainer tooling.");
const digest = createHash("sha256")
	.update(await readFile(join(product, "cli.js")))
	.digest("hex");
const id = randomUUID();
const pod = `kanban-maintainer-smoke-${id}`;
const container = `${pod}-runtime`;
const label = `io.kanban.maintainer-smoke=${id}`;
const command = (args) => {
	const result = spawnSync("podman", args, { encoding: "utf8", timeout: 180_000 });
	if (result.status !== 0)
		throw new Error(`Owned local pod smoke ${args[0]} failed: ${(result.stderr || result.stdout).slice(-6000)}`);
	return result.stdout;
};
let created = false;
let proof;
let failure = null;
try {
	command(["pod", "create", "--name", pod, "--network=none", "--label", label]);
	created = true;
	const output = command([
		"run",
		"--pull=never",
		"--rm",
		"--name",
		container,
		"--pod",
		pod,
		"--label",
		label,
		"--label",
		"io.containers.autoupdate=",
		"--security-opt=label=disable",
		"--volume",
		`${product}:/usr/local/lib/node_modules/@vombor/kanban/dist:ro`,
		"--volume",
		`${packagePath}:/usr/local/lib/node_modules/@vombor/kanban/package.json:ro`,
		"--env",
		"KANBAN_SMOKE_OBJECTIVES=1",
		image,
		"node",
		"-e",
		PRODUCT_SMOKE_PROBE,
	]);
	const result = JSON.parse(output.trim().split("\n").at(-1));
	proof = {
		status: "passed",
		imageId: image,
		productBundleSha256: digest,
		ownedPod: pod,
		nativeObjectiveFoundation: true,
		noProviderTurns: true,
		noLiveDataMounted: true,
		noBrowserLaunched: true,
		result,
	};
} catch (error) {
	failure = error;
} finally {
	if (created) {
		try {
			const response = JSON.parse(command(["pod", "inspect", pod]));
			const inspected = Array.isArray(response) ? response[0] : response;
			if (inspected.Labels?.["io.kanban.maintainer-smoke"] !== id)
				failure = new Error("Smoke pod ownership label mismatched; refusing cleanup.", { cause: failure });
			else command(["pod", "rm", "--force", pod]);
		} catch (error) {
			failure = failure
				? new AggregateError([failure, error], "Smoke and owned-resource cleanup failed; inspect both causes.")
				: error;
		}
	}
}
if (failure) throw failure;
process.stdout.write(`${JSON.stringify({ ...proof, ownedPodCleanupComplete: true })}\n`);
