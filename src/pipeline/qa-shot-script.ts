// Validate the whole browser journey before connecting/launching a browser: valid JSON is not a valid flow.
import { z } from "zod";

export const qaViewportSchema = z.string().refine((name) => {
	if (["mobile", "tablet", "desktop"].includes(name)) return true;
	const dimensions = /^(\d+)x(\d+)$/u.exec(name);
	return dimensions?.slice(1).every((value) => Number(value) > 0 && Number(value) <= 16_384) ?? false;
}, "Use mobile, tablet, desktop or positive WxH dimensions (at most 16384 per side)");

const timeout = z.number().int().positive().optional();
const selector = z.string().min(1);
const value = z.union([z.string(), z.number().finite()]);
const stepSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("goto"), url: z.string().optional(), timeout }).strict(),
	z.object({ type: z.literal("fill"), selector, value, timeout }).strict(),
	z.object({ type: z.literal("click"), selector, timeout }).strict(),
	z.object({ type: z.literal("press"), selector, key: z.string().min(1).optional(), timeout }).strict(),
	z.object({ type: z.literal("select"), selector, value, timeout }).strict(),
	z.object({ type: z.literal("waitFor"), selector, timeout }).strict(),
	z.object({ type: z.literal("wait"), ms: z.number().int().nonnegative().optional(), timeout }).strict(),
	z
		.object({ type: z.literal("expectText"), text: z.string().min(1), selector: selector.optional(), timeout })
		.strict(),
	z
		.object({
			type: z.literal("screenshot"),
			path: z.string().min(1).optional(),
			fullPage: z.boolean().optional(),
			timeout,
		})
		.strict(),
]);
const stepsSchema = z.array(stepSchema).min(1);
const envelopeSchema = z.object({ viewport: qaViewportSchema.optional(), steps: stepsSchema }).strict();

export type QaShotStep = z.infer<typeof stepSchema>;

/** An envelope may pin one viewport; otherwise arrays/envelopes run at every requested CLI viewport. */
export function parseQaShotScript(
	value: unknown,
	viewports: readonly string[],
): { viewports: string[]; steps: QaShotStep[] } {
	const spec = Array.isArray(value) ? stepsSchema.parse(value) : envelopeSchema.parse(value);
	const defaults = viewports.length > 0 ? z.array(qaViewportSchema).parse(viewports) : ["desktop"];
	return Array.isArray(spec)
		? { viewports: defaults, steps: spec }
		: { viewports: spec.viewport ? [spec.viewport] : defaults, steps: spec.steps };
}
