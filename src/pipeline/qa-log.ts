// The workspace's QA log (`data/<workspaceId>/qa-log.md`): an append-only markdown file of check results and QA
// verdicts that QA agents, the orchestrator and people read. The QA prompt quotes a card's earlier verdict sections
// from round 2 on, and the round of a new QA card is the number of verdict sections its dev card already has plus
// one.
//
// Ported from archive/devteam-kit:qa/qa-card.cjs@6da71597 (previousRounds, the round count) and
// services/kanban-autoland.mjs@6da71597 (ingestQaOnce: the section layout). The verdict heading stays
// `## Claude QA <dev>` whoever reviewed: foo's existing log, its round numbers and the legacy kit's parsers use it.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { EffectiveModel } from "../core/effective-agent";
import { getPipelineQaLogPath } from "../state/kanban-home";
import type { QaVerdict } from "./qa-verdict";

export type AppendQaLog = (workspaceId: string, text: string) => Promise<void>;

export function createQaLogAppender(getPath: (workspaceId: string) => string = getPipelineQaLogPath): AppendQaLog {
	// One write chain per file keeps sections whole and in order.
	const chains = new Map<string, Promise<void>>();
	return async (workspaceId, text) => {
		const path = getPath(workspaceId);
		const next = (chains.get(path) ?? Promise.resolve()).then(async () => {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, text, "utf8");
		});
		const settled = next.catch(() => {});
		chains.set(path, settled);
		try {
			await next;
		} finally {
			if (chains.get(path) === settled) {
				chains.delete(path);
			}
		}
	};
}

const SECTION_SPLIT = /^(?=## )/mu;
const MAX_QUOTED_SECTION_CHARS = 2500;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sectionHeading(devTaskId: string): RegExp {
	return new RegExp(`^## Claude QA ${escapeRegExp(devTaskId)}\\b`, "u");
}

export async function readQaLog(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

function getQaSections(text: string, devTaskId: string): string[] {
	const heading = sectionHeading(devTaskId);
	return text.split(SECTION_SPLIT).filter((section) => heading.test(section));
}

/** How many verdicts the dev card already has in the log. */
export function countQaLogRounds(text: string, devTaskId: string): number {
	return getQaSections(text, devTaskId).length;
}

/** The dev card's last two sections, for the QA prompt of the next round. */
export function getPreviousQaRounds(text: string, devTaskId: string): string {
	return getQaSections(text, devTaskId)
		.slice(-2)
		.map((section) => section.trim().slice(0, MAX_QUOTED_SECTION_CHARS))
		.join("\n\n");
}

/** The dev card's newest verdict section of `round`, else its newest section; "" when it has none. */
export function getQaLogSection(text: string, devTaskId: string, round: number): string {
	const sections = getQaSections(text, devTaskId);
	const ofRound = sections.filter(
		(section) => Number(/\(round (\d+)\)/u.exec(section.split("\n")[0] ?? "")?.[1] ?? 1) === round,
	);
	return (ofRound.at(-1) ?? sections.at(-1) ?? "").trimEnd();
}

export interface QaLogSectionInput {
	devTaskId: string;
	round: number;
	verdict: QaVerdict;
	/** Epoch ms. */
	at: number;
	dev: { agentId: string; model: EffectiveModel | null };
	reviewer: { qaTaskId: string; agentId: string; model: EffectiveModel | null };
	artifactsDir: string | null;
	verdictPath: string;
	/** Why the recorded verdict differs from the file's, or why there was none. */
	pipelineNote: string | null;
}

const SCORE_KEYS = ["spec", "correctness", "tests", "ux", "code", "process"] as const;

function describeModel(model: EffectiveModel | null): string {
	return model ? `${model.provider ?? "default provider"}/${model.model}` : "its default model";
}

export function formatQaLogSection(input: QaLogSectionInput): string {
	const { verdict } = input;
	const at = new Date(input.at).toISOString().slice(0, 16).replace("T", " ");
	const scores = verdict.scores;
	return [
		`## Claude QA ${input.devTaskId}${input.round > 1 ? ` (round ${input.round})` : ""}: ${verdict.verdict} (${at} UTC)`,
		verdict.log.trim() || "- (no details)",
		`- Dev: ${input.dev.agentId} on ${describeModel(input.dev.model)}`,
		`- Visual: ${verdict.visual.status}${verdict.visual.artifacts.length > 0 && input.artifactsDir ? `; artifacts in ${input.artifactsDir}` : ""}; card-caused console errors: ${verdict.visual.consoleErrors}`,
		scores
			? `- Scores: spec/correctness/tests/ux/code/process = ${SCORE_KEYS.map((key) => scores[key] ?? "–").join("/")}`
			: "- Scores: n/a",
		...(input.pipelineNote ? [`- Pipeline: ${input.pipelineNote}`] : []),
		`- Reviewer: ${input.reviewer.agentId} on ${describeModel(input.reviewer.model)}, QA card ${input.reviewer.qaTaskId}; ingested by Kanban from ${input.verdictPath}`,
	].join("\n");
}
