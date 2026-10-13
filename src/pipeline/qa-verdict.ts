// Reading a QA card's outbox verdict (`<outbox>/verdict.json`, the contract in step 6 of the QA prompt).
//
// Ported from archive/devteam-kit:lib/verdict-file.cjs@6da71597 (b9dd99b: a nudge quotes why the file is unusable,
// so a model that wrote invalid JSON learns what to fix; GLM wrote raw newlines in "log" and was nudged 6× as "not
// written") and services/kanban-autoland.mjs@6da71597 ingestQaOnce (the STALLED placeholder for a QA agent that
// stopped without a verdict; QA v4: a PASS with visual QA blocked is recorded as STALLED, because a UI card can't
// pass without visual evidence: 2c0d7 passed with visual blocked, 10/05).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const QA_VERDICT_FILENAME = "verdict.json";

export const qaVerdictValueSchema = z.enum(["PASS", "FAIL", "STALLED"]);
export type QaVerdictValue = z.infer<typeof qaVerdictValueSchema>;

// Each field falls back on its own, so one bad value (a score written as "5") never drops the rest, and above
// all never drops `visual.status: "blocked"`, which turns a PASS into STALLED.
const scoreSchema = z.number().nullable().optional().catch(null);

const checksBaseSchema = z.enum(["fails", "passes", "not_run"]);

/** One answer for a failed scripted-checks step (issue #41); a field that doesn't fit is null, never the entry. */
const checksAnswerSchema = z
	.object({
		step: z.string().optional().catch(undefined),
		reproduced: z.boolean().nullable().optional().catch(null),
		base: checksBaseSchema.nullable().optional().catch(null),
		evidence: z.unknown().optional(),
	})
	.loose();

/** Lenient on purpose: only `verdict` is required. Everything else is recorded as far as it is usable. */
const qaVerdictFileSchema = z
	.object({
		verdict: qaVerdictValueSchema,
		scores: z
			.object({
				spec: scoreSchema,
				correctness: scoreSchema,
				tests: scoreSchema,
				ux: scoreSchema,
				code: scoreSchema,
				process: scoreSchema,
			})
			.loose()
			.nullable()
			.optional()
			.catch(null),
		blocking: z.array(z.unknown()).optional().catch([]),
		visual: z
			.object({
				status: z.string().optional().catch(undefined),
				artifacts: z.array(z.unknown()).optional().catch([]),
				consoleErrors: z.number().optional().catch(undefined),
			})
			.loose()
			.nullable()
			.optional()
			.catch(null),
		notes: z.unknown().optional(),
		log: z.unknown().optional(),
		checks: z.array(z.unknown()).optional().catch([]),
	})
	.loose();

/** QA's answer for one failed step of the scripted checks (the checks report asks for it on a FAIL). */
export interface QaChecksAnswer {
	step: string;
	reproduced: boolean | null;
	base: z.infer<typeof checksBaseSchema> | null;
	evidence: string;
}

export interface QaVerdict {
	verdict: QaVerdictValue;
	scores: Record<string, number | null> | null;
	blocking: string[];
	visual: { status: string; artifacts: string[]; consoleErrors: number };
	notes: string;
	/** Markdown bullets for the QA log. */
	log: string;
	/** One answer per failed checks step; none when QA gave none (and in verdicts made before issue #41). */
	checks?: QaChecksAnswer[];
}

/**
 * Why a verdict can't be recorded yet: no file, an unusable one, or a PASS that doesn't answer for the failed checks
 * steps (`incomplete`, qa-checks-verdict.ts). Each is nudged, then recorded STALLED.
 */
export type QaVerdictUnusable = Exclude<QaVerdictRead, { kind: "ok" }> | { kind: "incomplete"; error: string };

export type QaVerdictRead =
	| { kind: "missing" }
	/** The file exists but is not usable; `error` is what the nudge quotes. */
	| { kind: "invalid"; error: string }
	| { kind: "ok"; verdict: QaVerdict };

function toText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => toText(entry)).join("\n");
	}
	return value === undefined || value === null ? "" : String(value);
}

function normalizeChecksAnswers(entries: unknown[]): QaChecksAnswer[] {
	return entries.flatMap((entry) => {
		const parsed = checksAnswerSchema.safeParse(entry);
		if (!parsed.success || !parsed.data.step?.trim()) {
			return [];
		}
		return [
			{
				step: parsed.data.step.trim(),
				reproduced: parsed.data.reproduced ?? null,
				base: parsed.data.base ?? null,
				evidence: toText(parsed.data.evidence).trim(),
			},
		];
	});
}

function normalizeVerdict(parsed: z.infer<typeof qaVerdictFileSchema>): QaVerdict {
	const scores = parsed.scores
		? Object.fromEntries(
				Object.entries(parsed.scores).map(([key, value]) => [key, typeof value === "number" ? value : null]),
			)
		: null;
	return {
		verdict: parsed.verdict,
		scores,
		blocking: (parsed.blocking ?? []).map((entry) => toText(entry)).filter(Boolean),
		visual: {
			status: parsed.visual?.status ?? "n/a",
			artifacts: (parsed.visual?.artifacts ?? []).filter((entry): entry is string => typeof entry === "string"),
			consoleErrors: parsed.visual?.consoleErrors ?? 0,
		},
		notes: toText(parsed.notes),
		log: toText(parsed.log),
		checks: normalizeChecksAnswers(parsed.checks ?? []),
	};
}

export function parseQaVerdictText(text: string): QaVerdictRead {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		return { kind: "invalid", error: `invalid JSON (${error instanceof Error ? error.message : String(error)})` };
	}
	const verdict =
		raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { verdict?: unknown }).verdict : undefined;
	const parsed = qaVerdictFileSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			kind: "invalid",
			error: `"verdict" must be one of ${qaVerdictValueSchema.options.join("/")} (got ${JSON.stringify(verdict) ?? "undefined"})`,
		};
	}
	return { kind: "ok", verdict: normalizeVerdict(parsed.data) };
}

export function getQaVerdictPath(outboxDir: string): string {
	return join(outboxDir, QA_VERDICT_FILENAME);
}

export async function readQaVerdictFile(outboxDir: string): Promise<QaVerdictRead> {
	let text: string;
	try {
		text = await readFile(getQaVerdictPath(outboxDir), "utf8");
	} catch {
		return { kind: "missing" };
	}
	return parseQaVerdictText(text);
}

/** What to tell an agent whose verdict.json can't be read (the error is quoted, so it learns what to fix). */
export function buildQaVerdictFixHint(file: string, error: string): string {
	return `${file} exists but is not usable: ${error}. Rewrite it as valid JSON (escape newlines inside strings as \\n, or make "log" an array of strings).`;
}

/** The nudge for a QA card that stopped without a usable verdict. */
export function buildQaVerdictNudge(outboxDir: string, read: QaVerdictUnusable, kanbanHome: string): string {
	const file = getQaVerdictPath(outboxDir);
	const ask =
		read.kind === "invalid"
			? buildQaVerdictFixHint(file, read.error)
			: read.kind === "incomplete"
				? `${file} is not accepted: ${read.error}. Add the "checks" key as the SCRIPTED CHECKS section says, or change the verdict.`
				: `Your review isn't finished: write ${file} exactly as step 6 says (valid JSON with verdict, scores, blocking, visual, notes, log).`;
	return `${ask} Then reply with the one-line summary. Don't run kanban commands or touch ${kanbanHome}.`;
}

/** Recorded when the QA agent stopped without a usable verdict and its nudges are used up. */
export function createStalledQaVerdict(reason: string): QaVerdict {
	return {
		verdict: "STALLED",
		scores: null,
		blocking: [],
		visual: { status: "n/a", artifacts: [], consoleErrors: 0 },
		notes: reason,
		log: `- ${reason} (the pipeline recorded STALLED).`,
		checks: [],
	};
}

/** QA v4: a UI card can't PASS without visual evidence. */
export function applyQaVerdictRules(verdict: QaVerdict): { verdict: QaVerdict; changed: string | null } {
	if (verdict.verdict === "PASS" && verdict.visual.status === "blocked") {
		return {
			verdict: {
				...verdict,
				verdict: "STALLED",
				notes: `PASS with visual QA blocked (a UI card can't pass without visual evidence); ${verdict.notes}`.slice(
					0,
					400,
				),
			},
			changed: "PASS with visual blocked → recorded as STALLED",
		};
	}
	return { verdict, changed: null };
}
