import { existsSync, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { KANBAN_SESSION_CREDENTIAL_ENV } from "../isolation/session-identity";
import { readKnowledgeFile } from "../knowledge/content-store";
import { evaluatorProfileSchema, evaluatorSuiteSchema } from "./contracts";
import { evaluateQaSuite, evaluationHash } from "./evaluator";
import { evaluatorCapability } from "./openai-adapter";
import { createPodmanEvaluatorSandbox, inspectEvaluatorImage } from "./sandbox";

async function ownedInput(path: string) {
	const info = await lstat(path);
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		info.mode & 0o022 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())
	)
		throw new Error("Evaluation input must be an operator-owned regular file without group/other write access.");
	return JSON.parse(await readKnowledgeFile(path, 1048576)) as unknown;
}
function refuseRepositoryOutput(path: string) {
	for (let current = resolve(path); ; current = dirname(current)) {
		if (
			lstatSync(join(current, ".git"), { throwIfNoEntry: false }) ||
			(lstatSync(join(current, "HEAD"), { throwIfNoEntry: false }) &&
				lstatSync(join(current, "objects"), { throwIfNoEntry: false }) &&
				lstatSync(join(current, "config"), { throwIfNoEntry: false }))
		)
			throw new Error("Evaluation reports must be outside application/shared Git workspaces.");
		if (dirname(current) === current) return;
	}
}
export async function runOperatorQaEvaluation(options: {
	profile: string;
	suite: string;
	image: string;
	out: string;
	execute: boolean;
	providerIdleConfirmed: boolean;
	maxTotalSec: number;
}) {
	if (
		process.platform !== "linux" ||
		process.getuid?.() === 0 ||
		existsSync("/run/.containerenv") ||
		existsSync("/.dockerenv") ||
		process.env[KANBAN_SESSION_CREDENTIAL_ENV]
	)
		throw new Error("QA evaluation is an explicit host-operator tool, never an inference/container/card process.");
	if (!Number.isInteger(options.maxTotalSec) || options.maxTotalSec < 10 || options.maxTotalSec > 900)
		throw new Error("Evaluation deadline must be 10–900 seconds.");
	if (options.execute && !options.providerIdleConfirmed)
		throw new Error(
			"Explicitly confirm the provider is idle; this evaluator cannot reserve or interrupt native card capacity.",
		);
	const profile = evaluatorProfileSchema.parse(await ownedInput(options.profile)),
		suite = evaluatorSuiteSchema.parse(await ownedInput(options.suite));
	const apiKey = profile.apiKeyEnv ? (process.env[profile.apiKeyEnv]?.trim() ?? null) : null;
	if (profile.apiKeyEnv && !apiKey)
		throw new Error(
			"The explicitly named evaluation credential variable is unavailable; no credential fallback was used.",
		);
	if (apiKey && JSON.stringify(profile).includes(apiKey))
		throw new Error("Capability metadata must not embed its credential value.");
	if (apiKey && JSON.stringify(suite).includes(apiKey))
		throw new Error("Evaluation source/metadata must not embed its request credential.");
	inspectEvaluatorImage(options.image);
	const preview = {
		version: 1,
		contract: "kanban-code-review-v1",
		profileFingerprint: evaluationHash(profile),
		suiteFingerprint: evaluationHash(suite),
		maxRequests: suite.cases.length * suite.variants.length,
		maxTotalSec: options.maxTotalSec,
		variants: suite.variants.map((variant) => ({
			id: variant.id,
			capability: evaluatorCapability(profile, variant) ?? "operator_declared_native_support_not_certified",
		})),
		imageId: options.image,
		noWorkflowOrProviderMutation: true,
	};
	if (!options.execute) return { ...preview, status: "dry_run_no_model_or_sandbox_execution" };
	refuseRepositoryOutput(options.out);
	const parent = await realpath(dirname(resolve(options.out))),
		out = join(parent, resolve(options.out).split(/[\\/]/u).at(-1) ?? "");
	refuseRepositoryOutput(out);
	await mkdir(out, { mode: 0o700 });
	const write = async (name: string, value: unknown) => {
		const path = join(out, name);
		await lockedFileSystem.writeJsonFileAtomic(path, value);
		await chmod(path, 0o600);
	};
	const reservation = { ...preview, status: "reserved_no_automatic_replay", createdAt: Date.now() };
	await write("reservation.json", reservation); // durable before any POST/container execution
	try {
		const report = await evaluateQaSuite({
			profile,
			suite,
			apiKey,
			sandbox: createPodmanEvaluatorSandbox(options.image),
			maxTotalSec: options.maxTotalSec,
			onRow: async (rows) => {
				await write("progress.json", { ...preview, status: "observed_partial_not_completion", rows });
			},
		});
		await write("report.json", report);
		return {
			...preview,
			status: report.matrixComplete ? "evaluation_recorded" : "evaluation_incomplete_no_replay",
			matrixComplete: report.matrixComplete,
			out,
			summary: report.summary,
			warning:
				"Separate format/classification/regression evidence; no model promotion, QA verdict, billing cap or guaranteed thinking improvement.",
		};
	} catch {
		await write("uncertain.json", { ...preview, status: "outcome_unknown_no_replay", at: Date.now() });
		throw new Error(
			"Evaluation could not be completed; retain the reservation/progress and investigate. No request was automatically replayed.",
		);
	}
}
