import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type EvaluationCase,
	type EvaluatorProfile,
	type EvaluatorSuite,
	namedInputsMatch,
	REVIEW_CONTRACT_VERSION,
} from "./contracts";
import { type EvaluationReply, evaluatorCapability, requestEvaluatorReview } from "./openai-adapter";
import type { SandboxRunner } from "./sandbox";

export const evaluationHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface EvaluationRow {
	caseId: string;
	variantId: string;
	status: EvaluationReply["status"] | "invalid_fixture" | "sandbox_unavailable" | "deadline";
	formatValid: boolean | null;
	classificationCorrect: boolean | null;
	falsePositive: boolean | null;
	regressionVerified: boolean | null;
	latencyMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	estimatedUsd: number | null;
	reason: string | null;
}
async function execute(
	test: EvaluationCase,
	source: string,
	inputs: Array<Record<string, unknown>>,
	sandbox: SandboxRunner,
) {
	return sandbox({ source, functionName: test.functionName, parameters: test.parameters, inputs });
}
async function versions(
	test: EvaluationCase,
	sources: string[],
	inputs: Array<Record<string, unknown>>,
	sandbox: SandboxRunner,
) {
	const results = [];
	for (const source of sources) {
		const result = await execute(test, source, inputs, sandbox);
		results.push(result);
		if (!result.cleanup) break;
	}
	return results;
}
export async function evaluateQaSuite(input: {
	profile: EvaluatorProfile;
	suite: EvaluatorSuite;
	apiKey: string | null;
	sandbox: SandboxRunner;
	fetchImpl?: typeof fetch;
	maxTotalSec?: number;
	onRow?: (rows: EvaluationRow[]) => Promise<void>;
}) {
	const started = Date.now(),
		deadline = started + (input.maxTotalSec ?? 300) * 1000,
		rows: EvaluationRow[] = [];
	let stop = false;
	const capabilities = new Map(
		input.suite.variants.map((variant) => [variant.id, evaluatorCapability(input.profile, variant)]),
	);
	for (const test of input.suite.cases) {
		const namedValid = test.trustedTests.every((entry) => namedInputsMatch(test.parameters, entry.inputs));
		let fixtureValid = false,
			sandboxAvailable = true,
			cleanupUnknown = false;
		if (namedValid && [...capabilities.values()].some((reason) => reason === null) && Date.now() < deadline) {
			const named = test.trustedTests.map((entry) => entry.inputs),
				expected = test.trustedTests.map((entry) => entry.expected);
			const results = await versions(test, [test.oracleSource, test.source, test.fixedSource], named, input.sandbox),
				[oracle, source, fixed] = results;
			cleanupUnknown = results.some((result) => !result.cleanup);
			sandboxAvailable = Boolean(
				oracle &&
					source &&
					fixed &&
					!cleanupUnknown &&
					[oracle, source, fixed].every((result) => result.ok || result.failure === "program"),
			);
			fixtureValid =
				sandboxAvailable &&
				Boolean(oracle?.ok && fixed?.ok) &&
				isDeepStrictEqual(oracle?.values, expected) &&
				isDeepStrictEqual(fixed?.values, expected) &&
				(test.expectedHasBug
					? !isDeepStrictEqual(source?.values, expected)
					: isDeepStrictEqual(source?.values, expected));
		}
		for (const variant of input.suite.variants) {
			if (stop) break;
			const base = {
				caseId: test.id,
				variantId: variant.id,
				formatValid: null,
				classificationCorrect: null,
				falsePositive: null,
				regressionVerified: null,
				latencyMs: null,
				inputTokens: null,
				outputTokens: null,
				estimatedUsd: null,
			};
			if (cleanupUnknown) {
				rows.push({ ...base, status: "sandbox_unavailable", reason: "sandbox_cleanup_unknown_no_more_work" });
				stop = true;
			} else if (capabilities.get(variant.id)) {
				rows.push({ ...base, status: "unsupported", reason: capabilities.get(variant.id) ?? null });
			} else if (Date.now() >= deadline) {
				rows.push({ ...base, status: "deadline", reason: "bounded_evaluation_deadline_no_more_requests" });
				stop = true;
			} else if (!fixtureValid)
				rows.push({
					...base,
					status: sandboxAvailable ? "invalid_fixture" : "sandbox_unavailable",
					reason: "independent_oracle_source_fixed_control_not_verified_no_model_request",
				});
			else {
				const remaining = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
				const reply = await requestEvaluatorReview({
					profile: {
						...input.profile,
						limits: {
							...input.profile.limits,
							requestTimeoutSec: Math.min(remaining, input.profile.limits.requestTimeoutSec),
						},
					},
					variant,
					test,
					apiKey: input.apiKey,
					fetchImpl: input.fetchImpl,
				});
				let regressionVerified: boolean | null = null;
				if (reply.output?.has_bug) {
					regressionVerified = true;
					for (const finding of reply.output.findings) {
						const regression = finding.regression;
						if (!regression || !namedInputsMatch(test.parameters, regression.inputs)) {
							regressionVerified = false;
							break;
						}
						if (Date.now() >= deadline) {
							regressionVerified = null;
							break;
						}
						const named = [regression.inputs],
							results = await versions(
								test,
								[test.oracleSource, test.source, regression.fixSource],
								named,
								input.sandbox,
							),
							[oracle, source, fixed] = results;
						if (
							!oracle ||
							!source ||
							!fixed ||
							results.some((result) => !result.cleanup || (!result.ok && result.failure !== "program"))
						) {
							regressionVerified = null;
							stop = true;
							break;
						}
						if (
							!oracle.ok ||
							!fixed.ok ||
							!isDeepStrictEqual(oracle.values, [regression.expected]) ||
							(source.ok && isDeepStrictEqual(source.values, oracle.values)) ||
							!isDeepStrictEqual(fixed.values, oracle.values)
						) {
							regressionVerified = false;
							break;
						}
					}
				}
				rows.push({
					...base,
					status: reply.status,
					formatValid: ["ok", "malformed", "truncated"].includes(reply.status) ? reply.status === "ok" : null,
					classificationCorrect: reply.output ? reply.output.has_bug === test.expectedHasBug : null,
					falsePositive: reply.output ? !test.expectedHasBug && reply.output.has_bug : null,
					regressionVerified,
					latencyMs: reply.latencyMs,
					inputTokens: reply.inputTokens,
					outputTokens: reply.outputTokens,
					estimatedUsd: reply.estimatedUsd,
					reason: reply.reason,
				});
				if (reply.status === "uncertain" || reply.status === "provider_rejected") stop = true;
			}
			await input.onRow?.(rows);
		}
		if (stop) break;
	}
	return {
		version: 1,
		contract: REVIEW_CONTRACT_VERSION,
		matrixComplete: !stop && rows.length === input.suite.cases.length * input.suite.variants.length,
		variants: input.suite.variants,
		cases: input.suite.cases.map((test) => ({
			id: test.id,
			expectedHasBug: test.expectedHasBug,
			parameters: test.parameters,
			sourceFingerprint: evaluationHash(test.source),
			oracleFingerprint: evaluationHash(test.oracleSource),
		})),
		profileFingerprint: evaluationHash(input.profile),
		suiteFingerprint: evaluationHash(input.suite),
		provider: input.profile.provider,
		model: input.profile.model,
		startedAt: started,
		finishedAt: Date.now(),
		rows,
		summary: {
			matrixRows: rows.length,
			requestsSent: rows.filter((row) => row.latencyMs !== null).length,
			formatAssessed: rows.filter((row) => row.formatValid !== null).length,
			classificationAssessed: rows.filter((row) => row.classificationCorrect !== null).length,
			formatValid: rows.filter((r) => r.formatValid === true).length,
			formatInvalid: rows.filter((r) => r.formatValid === false).length,
			classificationCorrect: rows.filter((r) => r.classificationCorrect === true).length,
			falsePositives: rows.filter((r) => r.falsePositive === true).length,
			regressionsVerified: rows.filter((r) => r.regressionVerified === true).length,
		},
		warnings: [
			"opt_in_evaluation_not_card_qa_acceptance_or_model_promotion",
			"capabilities_are_operator_declared_not_auto_certified",
			"small_bounded_AB_cohort_not_proof_thinking_improves_QA",
			"token_usage_provider_reported_total_cost_unknown_when_unpriced",
			"flat_operator_price_estimates_are_not_invoice_totals_or_spending_caps",
			"direct_evaluation_does_not_reserve_native_card_provider_capacity",
			"unknown_request_outcome_never_replayed",
			"sandbox_checks_are_bounded_examples_not_general_semantic_proof",
		],
		authority: "evaluation_only_no_workflow_or_provider_mutation",
	};
}
