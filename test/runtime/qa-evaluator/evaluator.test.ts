import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	buildCaseReviewSchema,
	evaluatorProfileSchema,
	evaluatorSuiteSchema,
	parseReviewOutput,
} from "../../../src/qa-evaluator/contracts";
import { evaluateQaSuite } from "../../../src/qa-evaluator/evaluator";
import { buildEvaluatorRequest, requestEvaluatorReview } from "../../../src/qa-evaluator/openai-adapter";
import type { SandboxRunner } from "../../../src/qa-evaluator/sandbox";

const profile = () =>
	evaluatorProfileSchema.parse({
		version: 1,
		provider: "owned-fake",
		model: "gemma-owned-fixture",
		adapter: "openai-compatible",
		baseUrl: "https://owned.invalid/v1",
		capabilities: {
			schema: "native_json_schema",
			streaming: "sse",
			reasoning: { kind: "enable_thinking", transport: "chat_template_kwargs" },
			evidence: "Owned fake capability metadata; no actual model experiment",
		},
		limits: { maxOutputTokens: 512, requestTimeoutSec: 2 },
	});
const suite = () =>
	evaluatorSuiteSchema.parse({
		version: 1,
		id: "owned-contract-fixture",
		variants: [
			{ id: "off", reasoning: { kind: "enable_thinking", enabled: false }, stream: false },
			{ id: "on", reasoning: { kind: "enable_thinking", enabled: true }, stream: true },
		],
		cases: Array.from({ length: 5 }, (_, index) => ({
			id: `case${index}`,
			requirement: "clamp returns value limited to min/max",
			source: index < 3 ? "BUGGY" : "FIXED",
			fixedSource: "FIXED",
			oracleSource: "ORACLE",
			functionName: "clamp",
			parameters: ["value", "min", "max"],
			expectedHasBug: index < 3,
			trustedTests: [
				{ inputs: { value: 5, min: 0, max: 10 }, expected: 5 },
				{ inputs: { value: 11, min: 0, max: 10 }, expected: 10 },
			],
		})),
	});
const findings = {
	has_bug: true,
	findings: [
		{
			explanation: "Above max returns min",
			location: "clamp branch",
			evidence: "clamp(11,0,10) returns 0; oracle returns 10",
			regression: { inputs: { value: 11, min: 0, max: 10 }, expected: 10, fixSource: "FIXED" },
		},
	],
};
const sandbox: SandboxRunner = async (input) => ({
	ok: true,
	cleanup: true,
	values: input.inputs.map((named) => {
		const value = Number(named.value),
			min = Number(named.min),
			max = Number(named.max);
		return value < min ? min : value > max ? (input.source === "BUGGY" ? min : max) : value;
	}),
});
function completed(content: string, finish = "stop") {
	return new Response(
		JSON.stringify({
			choices: [
				{
					index: 0,
					message: { content, reasoning_content: "PRIVATE REASONING MUST NOT ENTER THE FINAL REPORT" },
					finish_reason: finish,
				},
			],
			usage: { prompt_tokens: 100, completion_tokens: 20 },
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}
function streamed(content: string) {
	const frames = [
		{ choices: [{ index: 0, delta: { reasoning_content: "PRIVATE RAW THOUGHT" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: { content: content.slice(0, 10) }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: { content: content.slice(10) }, finish_reason: "stop" }] },
		{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
	];
	return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("opt-in separate QA evaluator (#69)", () => {
	it("counts a schema-valid but non-executing model fix as unverified, not a successful regression or an oracle rewrite", async () => {
		const p = profile(),
			s = suite();
		s.variants = s.variants.slice(0, 1);
		s.cases = s.cases.slice(0, 1);
		const bad = {
			...findings,
			findings: [
				{
					...findings.findings[0],
					regression: { inputs: { value: 11, min: 0, max: 10 }, expected: 10, fixSource: "BROKEN_FIX" },
				},
			],
		};
		const runner: SandboxRunner = async (input) =>
			input.source === "BROKEN_FIX"
				? { ok: false, values: null, cleanup: true, failure: "program" }
				: sandbox(input);
		const result = await evaluateQaSuite({
			profile: p,
			suite: s,
			apiKey: null,
			sandbox: runner,
			fetchImpl: async () => completed(JSON.stringify(bad)),
		});
		expect(result.rows[0]).toMatchObject({
			formatValid: true,
			classificationCorrect: true,
			regressionVerified: false,
		});
		expect(result.matrixComplete).toBe(true);
	});
	it("parses split UTF-8 SSE frames and leaves unreported/invalid usage unknown", async () => {
		const p = profile(),
			s = suite(),
			test = s.cases[0],
			variant = s.variants[1];
		if (!test || !variant) throw new Error("Missing fixture");
		const content = JSON.stringify({
				...findings,
				findings: [{ ...findings.findings[0], explanation: "Bounded 🌱 finding" }],
			}),
			bytes = new TextEncoder().encode(await streamed(content).text());
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
					controller.close();
				},
			}),
		);
		expect(
			(await requestEvaluatorReview({ profile: p, variant, test, apiKey: null, fetchImpl: async () => response }))
				.status,
		).toBe("ok");
		const missing = await requestEvaluatorReview({
			profile: p,
			variant: { ...variant, stream: false },
			test,
			apiKey: null,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: '{"has_bug":false,"findings":[]}' }, finish_reason: "stop" }],
						usage: { prompt_tokens: "unknown", completion_tokens: null },
					}),
				),
		});
		expect(missing).toMatchObject({ status: "ok", inputTokens: null, outputTokens: null, estimatedUsd: null });
	});
	it("sends native strict schemas and only the explicitly supported thinking control, separating streaming reasoning/final channels", async () => {
		const p = profile(),
			s = suite(),
			test = s.cases[0],
			variant = s.variants[1];
		if (!test || !variant) throw new Error("Missing fixture");
		const request = buildEvaluatorRequest(p, variant, test);
		expect(request.response_format).toMatchObject({
			type: "json_schema",
			json_schema: { strict: true, name: "kanban_code_review_v1" },
		});
		expect(request).toMatchObject({ chat_template_kwargs: { enable_thinking: true }, stream: true });
		expect(request).not.toHaveProperty("reasoning_effort");
		const result = await requestEvaluatorReview({
			profile: p,
			variant,
			test,
			apiKey: null,
			fetchImpl: async () => streamed(JSON.stringify(findings)),
		});
		expect(result).toMatchObject({
			status: "ok",
			output: findings,
			inputTokens: 100,
			outputTokens: 20,
			estimatedUsd: null,
		});
		expect(JSON.stringify(result)).not.toContain("PRIVATE RAW THOUGHT");
		const native = z.toJSONSchema(buildCaseReviewSchema(test));
		expect(JSON.stringify(native)).toContain('"additionalProperties":false');
	});
	it("supports reasoning-effort and non-thinking profiles without a universal enable_thinking flag", () => {
		const p = profile(),
			s = suite(),
			test = s.cases[0];
		if (!test) throw new Error("Missing fixture");
		const effort = evaluatorProfileSchema.parse({
			...p,
			model: "effort-fixture",
			capabilities: {
				...p.capabilities,
				outputTokenParameter: "max_completion_tokens",
				reasoning: { kind: "reasoning_effort", values: ["low", "high"] },
			},
		});
		const request = buildEvaluatorRequest(
			effort,
			{ id: "effort", reasoning: { kind: "reasoning_effort", effort: "high" }, stream: false },
			test,
		);
		expect(request).toMatchObject({ reasoning_effort: "high", max_completion_tokens: 512 });
		expect(request).not.toHaveProperty("chat_template_kwargs");
		expect(request).not.toHaveProperty("max_tokens");
		const coder = evaluatorProfileSchema.parse({
			...p,
			capabilities: { ...p.capabilities, reasoning: { kind: "none" } },
		});
		const plain = buildEvaluatorRequest(coder, { id: "plain", reasoning: { kind: "none" }, stream: false }, test);
		expect(plain).not.toHaveProperty("chat_template_kwargs");
		expect(plain).not.toHaveProperty("reasoning_effort");
	});
	it("produces distinct format/classification/regression/token/latency evidence for a bounded fake 5-case A/B matrix without relabelling old results", async () => {
		const p = profile(),
			s = suite(),
			original = JSON.stringify(s),
			fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
				const body = z
					.object({ stream: z.boolean(), messages: z.array(z.object({ content: z.string() })) })
					.parse(JSON.parse(String(init?.body)));
				const user = z.object({ source: z.string() }).parse(JSON.parse(body.messages[1]?.content ?? "{}"));
				const output = JSON.stringify(user.source === "BUGGY" ? findings : { has_bug: false, findings: [] });
				return body.stream ? streamed(output) : completed(output);
			});
		const result = await evaluateQaSuite({ profile: p, suite: s, apiKey: null, sandbox, fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(10);
		expect(result.summary).toMatchObject({
			matrixRows: 10,
			requestsSent: 10,
			formatValid: 10,
			classificationCorrect: 10,
			falsePositives: 0,
			regressionsVerified: 6,
		});
		expect(JSON.stringify(s)).toBe(original);
		expect(result.authority).toBe("evaluation_only_no_workflow_or_provider_mutation");
		expect(result.rows.every((row) => row.estimatedUsd === null && row.latencyMs !== null)).toBe(true);
	});
	it("refuses malformed/null explanations, wrong named nesting and raw-thought final text without repair", async () => {
		const p = profile(),
			s = suite(),
			test = s.cases[0],
			variant = s.variants[0];
		if (!test || !variant) throw new Error("Missing fixture");
		for (const content of [
			JSON.stringify({ ...findings, findings: [{ ...findings.findings[0], explanation: null }] }),
			JSON.stringify({
				...findings,
				findings: [
					{
						...findings.findings[0],
						regression: { inputs: { args: [11, 0, 10] }, expected: 10, fixSource: "FIXED" },
					},
				],
			}),
			`<think>raw</think>${JSON.stringify(findings)}`,
			"{broken",
		]) {
			const result = await requestEvaluatorReview({
				profile: p,
				variant,
				test,
				apiKey: null,
				fetchImpl: async () => completed(content),
			});
			expect(result.status).toBe("malformed");
			expect(result.output).toBeNull();
		}
		expect(parseReviewOutput('{"has_bug":false,"findings":[]}')).toEqual({ has_bug: false, findings: [] });
		expect(parseReviewOutput('{"has_bug":true,"findings":[]}')).toBeNull();
	});
	it("never sends unsupported schema/reasoning/streaming controls or silently retries provider rejections", async () => {
		const p = profile(),
			s = suite(),
			test = s.cases[0],
			variant = s.variants[1];
		if (!test || !variant) throw new Error("Missing fixture");
		const fetchImpl = vi.fn(async () => completed("{}"));
		const unsupported = evaluatorProfileSchema.parse({
			...p,
			capabilities: { ...p.capabilities, schema: "unsupported" },
		});
		expect(
			(await requestEvaluatorReview({ profile: unsupported, variant, test, apiKey: null, fetchImpl })).status,
		).toBe("unsupported");
		expect(fetchImpl).not.toHaveBeenCalled();
		for (const capabilities of [
			{ ...p.capabilities, streaming: "unsupported" },
			{ ...p.capabilities, reasoning: { kind: "none" } },
		]) {
			const unsupportedControl = evaluatorProfileSchema.parse({ ...p, capabilities });
			expect(
				(await requestEvaluatorReview({ profile: unsupportedControl, variant, test, apiKey: null, fetchImpl }))
					.status,
			).toBe("unsupported");
		}
		expect(fetchImpl).not.toHaveBeenCalled();
		const result = await requestEvaluatorReview({
			profile: p,
			variant,
			test,
			apiKey: null,
			fetchImpl: async () => new Response("PRIVATE PROVIDER ERROR", { status: 400 }),
		});
		expect(result.status).toBe("provider_rejected");
		expect(JSON.stringify(result)).not.toContain("PRIVATE");
		const truncated = await requestEvaluatorReview({
			profile: p,
			variant: { ...variant, stream: false },
			test,
			apiKey: null,
			fetchImpl: async () => completed('{"has_bug":false,"findings":[]}', "length"),
		});
		expect(truncated.status).toBe("truncated");
	});
	it("uses independent oracle expectations rather than accepting a model's wrong expected output or false positive", async () => {
		const p = profile(),
			s = suite();
		s.variants = s.variants.slice(0, 1);
		s.cases = s.cases.slice(0, 1);
		const wrong = {
			...findings,
			findings: [
				{
					...findings.findings[0],
					regression: { inputs: { value: 11, min: 0, max: 10 }, expected: 0, fixSource: "FIXED" },
				},
			],
		};
		const result = await evaluateQaSuite({
			profile: p,
			suite: s,
			apiKey: null,
			sandbox,
			fetchImpl: async () => completed(JSON.stringify(wrong)),
		});
		expect(result.rows[0]).toMatchObject({
			formatValid: true,
			classificationCorrect: true,
			regressionVerified: false,
		});
		const clean = suite();
		clean.variants = clean.variants.slice(0, 1);
		clean.cases = clean.cases.slice(4);
		const falsePositive = await evaluateQaSuite({
			profile: p,
			suite: clean,
			apiKey: null,
			sandbox,
			fetchImpl: async () => completed(JSON.stringify(findings)),
		});
		expect(falsePositive.rows[0]).toMatchObject({
			falsePositive: true,
			classificationCorrect: false,
			regressionVerified: false,
		});
	});
	it("stops on unknown cleanup/request outcomes, never invokes generated code on the host and preserves unknown costs", async () => {
		const p = profile(),
			s = suite(),
			fetchImpl = vi.fn(async () => {
				throw new Error("PRIVATE CREDENTIAL ECHO");
			});
		const unknown = await evaluateQaSuite({ profile: p, suite: s, apiKey: null, sandbox, fetchImpl });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(unknown.rows[0]).toMatchObject({ status: "uncertain", formatValid: null, estimatedUsd: null });
		expect(JSON.stringify(unknown)).not.toContain("CREDENTIAL ECHO");
		const unsafe = vi.fn<SandboxRunner>(async () => ({ ok: false, cleanup: false, values: null }));
		fetchImpl.mockClear();
		const stopped = await evaluateQaSuite({ profile: p, suite: s, apiKey: null, sandbox: unsafe, fetchImpl });
		expect(unsafe).toHaveBeenCalledTimes(1);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(stopped.rows[0]?.reason).toBe("sandbox_cleanup_unknown_no_more_work");
	});
});
