import { z } from "zod";
import { hasControlCharacters } from "../trpc/knowledge-contract";

const name = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/u)
	.refine((value) => !Object.hasOwn(Object.prototype, value) && value !== "prototype");
const text = (max: number) => z.string().min(1).max(max);
export const reviewOutputSchema = z
	.object({
		has_bug: z.boolean(),
		findings: z
			.array(
				z
					.object({
						explanation: text(2000),
						location: text(500),
						evidence: text(2000),
						regression: z
							.object({ inputs: z.record(name, z.json()), expected: z.json(), fixSource: text(65536) })
							.strict()
							.nullable(),
					})
					.strict(),
			)
			.max(10),
	})
	.strict();
export const REVIEW_CONTRACT_VERSION = "kanban-code-review-v1";
export const reviewOutputJsonSchema = z.toJSONSchema(reviewOutputSchema, { target: "draft-7" });
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export function parseReviewOutput(text: string, test?: EvaluationCase): ReviewOutput | null {
	try {
		const raw: unknown = JSON.parse(text),
			output = reviewOutputSchema.parse(raw);
		if (
			output.has_bug !== Boolean(output.findings.length) ||
			(test && !buildCaseReviewSchema(test).safeParse(raw).success)
		)
			return null;
		return output;
	} catch {
		return null;
	}
}
const effortValue = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
export const reasoningRequestSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }).strict(),
	z.object({ kind: z.literal("enable_thinking"), enabled: z.boolean() }).strict(),
	z
		.object({
			kind: z.literal("reasoning_effort"),
			effort: effortValue,
		})
		.strict(),
]);
export const evaluatorProfileSchema = z
	.object({
		version: z.literal(1),
		provider: text(80),
		model: text(240),
		adapter: z.enum(["openai-compatible", "unsupported"]),
		baseUrl: z
			.string()
			.url()
			.refine((value) => {
				const url = new URL(value);
				return (
					["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
				);
			}),
		apiKeyEnv: z
			.string()
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
			.optional(),
		allowInsecureHttpAuth: z.boolean().default(false),
		capabilities: z
			.object({
				schema: z.enum(["native_json_schema", "unsupported"]),
				streaming: z.enum(["sse", "unsupported"]),
				outputTokenParameter: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
				reasoning: z.discriminatedUnion("kind", [
					z.object({ kind: z.literal("none") }).strict(),
					z.object({ kind: z.literal("enable_thinking"), transport: z.literal("chat_template_kwargs") }).strict(),
					z
						.object({
							kind: z.literal("reasoning_effort"),
							values: z.array(effortValue).min(1).max(12),
						})
						.strict(),
				]),
				evidence: text(1000),
			})
			.strict(),
		limits: z
			.object({
				maxOutputTokens: z.number().int().min(64).max(8192),
				requestTimeoutSec: z.number().int().min(1).max(120),
			})
			.strict(),
		prices: z
			.object({ inputPerMillion: z.number().nonnegative(), outputPerMillion: z.number().nonnegative() })
			.strict()
			.optional(),
	})
	.strict();
export type EvaluatorProfile = z.infer<typeof evaluatorProfileSchema>;
export const evaluatorSuiteSchema = z
	.object({
		version: z.literal(1),
		id: text(80),
		variants: z
			.array(
				z.object({ id: text(80), reasoning: reasoningRequestSchema, stream: z.boolean().default(false) }).strict(),
			)
			.min(1)
			.max(2),
		cases: z
			.array(
				z
					.object({
						id: text(80),
						requirement: text(8000),
						source: text(65536),
						fixedSource: text(65536),
						oracleSource: text(65536),
						functionName: name,
						parameters: z
							.array(name)
							.max(12)
							.refine((values) => new Set(values).size === values.length),
						expectedHasBug: z.boolean(),
						trustedTests: z
							.array(z.object({ inputs: z.record(name, z.json()), expected: z.json() }).strict())
							.min(1)
							.max(10),
					})
					.strict(),
			)
			.min(1)
			.max(5),
	})
	.strict()
	.superRefine((suite, context) => {
		if (
			new Set(suite.variants.map((v) => v.id)).size !== suite.variants.length ||
			new Set(suite.cases.map((c) => c.id)).size !== suite.cases.length
		)
			context.addIssue({ code: "custom", message: "Case/variant ids must be unique" });
		if (
			hasControlCharacters(suite.id) ||
			suite.variants.some((v) => hasControlCharacters(v.id)) ||
			suite.cases.some((c) => hasControlCharacters(c.id))
		)
			context.addIssue({ code: "custom", message: "Ids cannot contain control characters" });
	});
export type EvaluatorSuite = z.infer<typeof evaluatorSuiteSchema>;
export type EvaluationCase = EvaluatorSuite["cases"][number];
export function namedInputsMatch(parameters: readonly string[], inputs: Record<string, unknown>) {
	return (
		Object.keys(inputs).length === parameters.length &&
		parameters.every((parameter) => Object.hasOwn(inputs, parameter))
	);
}

/** Closed shapes from owner-authored trusted examples, never inferred/repaired from a model's argument nesting. */
function exampleShape(values: unknown[], depth = 0): z.ZodType {
	if (depth > 6 || values.length > 100 || !values.length) throw new Error("Trusted input shape unavailable");
	const shapes = values.map((value) => {
		if (value === null) return z.null();
		if (typeof value === "string") return z.string();
		if (typeof value === "number") return z.number();
		if (typeof value === "boolean") return z.boolean();
		if (Array.isArray(value)) return z.array(exampleShape(value, depth + 1)).max(100);
		if (value && typeof value === "object")
			return z
				.object(
					Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exampleShape([item], depth + 1)])),
				)
				.strict();
		throw new Error("Trusted JSON shape unavailable");
	});
	const unique = [...new Map(shapes.map((shape) => [JSON.stringify(z.toJSONSchema(shape)), shape])).values()];
	const [first, second, ...rest] = unique;
	if (!first) throw new Error("Trusted input shape unavailable");
	if (!second) return first;
	return z.union([first, second, ...rest]);
}
export function buildCaseReviewSchema(test: EvaluationCase) {
	if (test.trustedTests.some((entry) => !namedInputsMatch(test.parameters, entry.inputs)))
		throw new Error("Trusted named inputs do not match signature");
	const inputs = z
		.object(
			Object.fromEntries(
				test.parameters.map((parameter) => [
					parameter,
					exampleShape(test.trustedTests.map((entry) => entry.inputs[parameter])),
				]),
			),
		)
		.strict();
	const regression = z
		.object({
			inputs,
			expected: exampleShape(test.trustedTests.map((entry) => entry.expected)),
			fixSource: text(65536),
		})
		.strict()
		.nullable();
	const finding = reviewOutputSchema.shape.findings.element.extend({ regression }).strict();
	return z.object({ has_bug: z.boolean(), findings: z.array(finding).max(10) }).strict();
}
