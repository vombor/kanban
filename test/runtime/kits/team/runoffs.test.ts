import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getBuiltInKits, getDefaultKit, resolveKitLayers } from "../../../../src/kits/resolve-kit";
import {
	buildRunoffEntry,
	getTierContenders,
	parseRunoffModelSpec,
	planRunoffCards,
} from "../../../../src/kits/team/runoffs/runoff-create";
import {
	decideRunoff,
	getRunoffPreserveTag,
	type RunoffCardFacts,
} from "../../../../src/kits/team/runoffs/runoff-decision";
import {
	findOpenRunoff,
	type RunoffEntry,
	readRunoffs,
	reopenRunoffWithoutWinner,
	updateRunoffs,
} from "../../../../src/kits/team/runoffs/runoffs-store";
import { createTempDir } from "../../../utilities/temp-dir";

function passed(id: string, overrides: Partial<RunoffCardFacts> = {}): RunoffCardFacts {
	return {
		id,
		column: "review",
		escalated: false,
		held: { round: 2, snapshot: `snap-${id}`, at: "2026-10-06T03:38:23.305Z" },
		currentSnapshot: `snap-${id}`,
		model: `us.openai.${id}`,
		scores: [4, 4, 4],
		fails: 1,
		cost: 1,
		...overrides,
	};
}

const RUNOFF: RunoffEntry = { name: "tier3-multiregion-2026-10-06", cards: ["0789a", "b41c8"], decided: null };

const NOW = Date.parse("2026-10-06T04:00:00.000Z");
const decide = (runoff: RunoffEntry, cards: RunoffCardFacts[]) => decideRunoff(runoff, cards, { now: NOW });

describe("runoff decision", () => {
	it("picks the higher mean score (the 10/06 tier-3 runoff: sol 4.0 over luna 3.67)", () => {
		const decision = decide(RUNOFF, [
			passed("0789a", { model: "us.openai.gpt-6-luna", scores: [4, 4, 3], cost: null }),
			passed("b41c8", { model: "us.openai.gpt-6.1-sol", scores: [4, 4, 4], cost: 1.66 }),
		]);
		expect(decision.kind).toBe("decided");
		if (decision.kind !== "decided") {
			return;
		}
		expect(decision.winner).toMatchObject({ id: "b41c8", score: 4 });
		expect(decision.land?.id).toBe("b41c8");
		expect(decision.discard.map((result) => result.id)).toEqual(["0789a"]);
		expect(decision.results.find((result) => result.id === "0789a")).toMatchObject({ out: "pass", score: 3.67 });
	});

	it("breaks a score tie on fewer FAIL rounds, then on lower cost (unknown cost last)", () => {
		const byFails = decide(RUNOFF, [passed("0789a", { fails: 2 }), passed("b41c8", { fails: 0 })]);
		expect(byFails.kind === "decided" && byFails.winner?.id).toBe("b41c8");
		const byCost = decide(RUNOFF, [passed("0789a", { cost: null }), passed("b41c8", { cost: 3 })]);
		expect(byCost.kind === "decided" && byCost.winner?.id).toBe("b41c8");
		const cheaper = decide(RUNOFF, [passed("0789a", { cost: 0.5 }), passed("b41c8", { cost: 3 })]);
		expect(cheaper.kind === "decided" && cheaper.winner?.id).toBe("0789a");
	});

	it("waits while a card works, is not in Review, or was QA'd on an older snapshot", () => {
		expect(decide(RUNOFF, [passed("0789a"), passed("b41c8", { column: "in_progress" })])).toEqual({
			kind: "open",
			waitingFor: ["b41c8"],
		});
		expect(decide(RUNOFF, [passed("0789a"), passed("b41c8", { held: null })]).kind).toBe("open");
		expect(decide(RUNOFF, [passed("0789a"), passed("b41c8", { currentSnapshot: "snap-new" })]).kind).toBe("open");
	});

	it("a card not on the board yet counts as being created in a new runoff, as deleted in an older one", () => {
		const fresh = { ...RUNOFF, createdAt: new Date(NOW - 60_000).toISOString() };
		expect(decide(fresh, [passed("0789a"), passed("b41c8", { column: null })])).toEqual({
			kind: "open",
			waitingFor: ["b41c8"],
		});
		const old = { ...RUNOFF, createdAt: new Date(NOW - 11 * 60_000).toISOString() };
		expect(decide(old, [passed("0789a"), passed("b41c8", { column: null })]).kind).toBe("closed_by_hand");
	});

	it("decides once the others passed and leaves escalated cards alone", () => {
		const decision = decide(RUNOFF, [passed("0789a"), passed("b41c8", { escalated: true, held: null })]);
		expect(decision).toMatchObject({ kind: "decided", winner: { id: "0789a" }, discard: [] });
		expect(decision.kind === "decided" && decision.results[1]).toEqual({ id: "b41c8", out: "escalated" });
		const none = decide(RUNOFF, [
			passed("0789a", { escalated: true, held: null }),
			passed("b41c8", { escalated: true, held: null }),
		]);
		expect(none).toMatchObject({ kind: "decided", winner: null, land: null, discard: [] });
	});

	it("benchOnly: nothing lands and every PASS, the winner's included, is discarded", () => {
		const decision = decide({ ...RUNOFF, benchOnly: true }, [
			passed("0789a", { scores: [3] }),
			passed("b41c8", { scores: [5] }),
		]);
		expect(decision).toMatchObject({ kind: "decided", winner: { id: "b41c8" }, land: null });
		expect(decision.kind === "decided" && decision.discard.map((result) => result.id)).toEqual(["b41c8", "0789a"]);
	});

	it("closes a runoff trashed by hand with no winner when no card held a PASS (tier2-coupons 10/06 08:51Z)", () => {
		const coupons: RunoffEntry = { name: "tier2-coupons-2026-10-06", cards: ["096bd", "c9e97"] };
		const decision = decide(coupons, [
			passed("096bd", { column: "trash", held: null }),
			passed("c9e97", { column: "trash", held: null }),
		]);
		expect(decision).toMatchObject({ kind: "closed_by_hand", winner: null });
		expect(decision.kind === "closed_by_hand" && decision.note).toContain("no winner");
	});

	it("a runoff closed by hand has a winner only if exactly one trashed card held a PASS; a deleted one never wins", () => {
		const one = decide(RUNOFF, [
			passed("0789a", { column: "trash" }),
			passed("b41c8", { column: "trash", held: null }),
		]);
		expect(one).toMatchObject({ kind: "closed_by_hand", winner: "0789a" });
		const two = decide(RUNOFF, [passed("0789a", { column: "trash" }), passed("b41c8", { column: "trash" })]);
		expect(two).toMatchObject({ kind: "closed_by_hand", winner: null });
		const deleted = decide(RUNOFF, [passed("0789a", { column: null }), passed("b41c8")]);
		expect(deleted).toMatchObject({ kind: "closed_by_hand", winner: null });
		expect(deleted.kind === "closed_by_hand" && deleted.results[0]).toEqual({ id: "0789a", out: "gone" });
	});

	it("names preserve tags preserve/<id>-<model> like the rework stage", () => {
		expect(getRunoffPreserveTag({ id: "0789a", model: "us.openai.gpt-6-luna" })).toBe("preserve/0789a-gpt-6-luna");
		expect(getRunoffPreserveTag({ id: "0789a", model: null })).toBe("preserve/0789a-unknown");
	});
});

describe("runoffs.json", () => {
	let temp: ReturnType<typeof createTempDir> | null = null;
	afterEach(() => {
		temp?.cleanup();
		temp = null;
	});
	const createPath = () => {
		temp = createTempDir("kanban-runoffs-");
		return join(temp.path, "data", "foo", "runoffs.json");
	};

	it("reads a missing file as empty and keeps entries it can't parse when it writes", async () => {
		const path = createPath();
		expect(await readRunoffs(path)).toEqual({ runoffs: [], issues: [] });
		await updateRunoffs(path, (runoffs) => {
			runoffs.push({ name: "a", cards: ["x", "y"], decided: null });
		});
		const raw = JSON.parse(readFileSync(path, "utf8")) as { runoffs: unknown[] };
		writeFileSync(path, JSON.stringify({ runoffs: [{ broken: true }, ...raw.runoffs] }));

		await updateRunoffs(path, (runoffs) => {
			runoffs.push({ name: "b", cards: ["z", "w"], decided: null, hand: "kept" });
		});

		const after = JSON.parse(readFileSync(path, "utf8")) as { runoffs: Array<Record<string, unknown>> };
		expect(after.runoffs).toEqual([
			{ broken: true },
			{ name: "a", cards: ["x", "y"], decided: null },
			{ name: "b", cards: ["z", "w"], decided: null, hand: "kept" },
		]);
		const read = await readRunoffs(path);
		expect(read.runoffs.map((runoff) => runoff.name)).toEqual(["a", "b"]);
		expect(read.issues).toHaveLength(1);
		expect(findOpenRunoff(read.runoffs, "z")?.name).toBe("b");
		expect(findOpenRunoff([{ name: "c", cards: ["z"], abandoned: true }], "z")).toBeNull();
	});

	it("reopens a runoff decided with no winner at a handback, keeping the old decision (158817d)", async () => {
		const path = createPath();
		await updateRunoffs(path, (runoffs) => {
			runoffs.push(
				{ name: "won", cards: ["a1", "a2"], decided: "2026-10-06T03:38:25Z", winner: "a1" },
				{
					name: "tier2-coupons",
					cards: ["096bd", "c9e97"],
					decided: "2026-10-06T06:26:52Z",
					winner: null,
					results: [{ id: "096bd", out: "escalated" }],
				},
			);
		});

		expect(await reopenRunoffWithoutWinner(path, "a1", "2026-10-06T06:30:28Z")).toBeNull();
		expect(await reopenRunoffWithoutWinner(path, "c9e97", "2026-10-06T06:30:28Z")).toBe("tier2-coupons");

		const { runoffs } = await readRunoffs(path);
		expect(runoffs[1]).toEqual({
			name: "tier2-coupons",
			cards: ["096bd", "c9e97"],
			reopened: [
				{
					at: "2026-10-06T06:30:28Z",
					by: "c9e97",
					decided: "2026-10-06T06:26:52Z",
					results: [{ id: "096bd", out: "escalated" }],
				},
			],
		});
		expect(findOpenRunoff(runoffs, "096bd")?.name).toBe("tier2-coupons");
	});
});

describe("runoff create", () => {
	const team = (() => {
		const kit = getBuiltInKits().get("team");
		if (!kit) {
			throw new Error("team kit missing");
		}
		const resolved = resolveKitLayers(getDefaultKit(), kit, {});
		if (!resolved.ok) {
			throw new Error(resolved.error);
		}
		return resolved.kit;
	})();

	it("parses [agent:][provider/]model, and a colon inside a model id is not an agent", () => {
		expect(parseRunoffModelSpec("cline:bedrock/us.openai.gpt-6.1-sol", "claude")).toEqual({
			agentId: "cline",
			provider: "bedrock",
			model: "us.openai.gpt-6.1-sol",
		});
		expect(parseRunoffModelSpec("us.anthropic.claude-haiku-4-5-20251001-v1:0", "cline")).toEqual({
			agentId: "cline",
			provider: null,
			model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		});
		expect(parseRunoffModelSpec("lemonade/Qwen/Qwen3-Coder", "cline")).toMatchObject({
			provider: "lemonade",
			model: "Qwen/Qwen3-Coder",
		});
	});

	it("races every usable model of a tier, skipping dropped ones", () => {
		expect(getTierContenders(team, "tier2", "cline").map((contender) => contender.model)).toEqual([
			"us.moonshotai.kimi-k3",
			"us.anthropic.claude-opus-5-5",
		]);
		// nova-2-lite is listed under qa but dropped.
		expect(getTierContenders(team, "qa", "cline").map((contender) => contender.model)).toEqual([
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		]);
		expect(() => getTierContenders(team, "tier9", "cline")).toThrow('tier "tier9" is not in kit "team"');
	});

	it("plans one card per model on the same prompt and base, and refuses a bad runoff", () => {
		const contenders = getTierContenders(team, "tier2", "cline");
		const plan = (overrides: Partial<Parameters<typeof planRunoffCards>[0]> = {}) =>
			planRunoffCards({
				name: "tier2-coupons",
				title: "Coupons",
				prompt: "Build coupons",
				baseRef: "bench/pre-runoff-tier2",
				contenders,
				resolveProvider: () => "bedrock",
				existing: [],
				...overrides,
			});
		const cards = plan();
		expect(cards.map((card) => [card.title, card.agentId, card.agentSettings, card.baseRef, card.prompt])).toEqual([
			[
				"Coupons [runoff tier2-coupons: kimi-k3]",
				"cline",
				{ providerId: "bedrock", modelId: "us.moonshotai.kimi-k3" },
				"bench/pre-runoff-tier2",
				"Build coupons",
			],
			[
				"Coupons [runoff tier2-coupons: claude-opus-5-5]",
				"cline",
				{ providerId: "bedrock", modelId: "us.anthropic.claude-opus-5-5" },
				"bench/pre-runoff-tier2",
				"Build coupons",
			],
		]);
		expect(() => plan({ existing: [{ name: "tier2-coupons", cards: [] }] })).toThrow("already has a runoff");
		expect(() => plan({ contenders: contenders.slice(0, 1) })).toThrow("at least two models");
		expect(() => plan({ contenders: [contenders[0], contenders[0]].flatMap((c) => (c ? [c] : [])) })).toThrow(
			"named twice",
		);
		expect(() => plan({ name: "bad name" })).toThrow("letters, digits");

		const entry = buildRunoffEntry({
			name: "tier2-coupons",
			created: cards.map((card, index) => ({ taskId: `t${index}`, card })),
			baseRef: "bench/pre-runoff-tier2",
			promptSource: "inline",
			benchOnly: true,
			createdAt: "2026-10-07T00:00:00.000Z",
		});
		expect(entry).toEqual({
			name: "tier2-coupons",
			cards: ["t0", "t1"],
			models: { t0: "bedrock/us.moonshotai.kimi-k3", t1: "bedrock/us.anthropic.claude-opus-5-5" },
			base: "bench/pre-runoff-tier2",
			prompt: "inline",
			createdAt: "2026-10-07T00:00:00.000Z",
			benchOnly: true,
			decided: null,
		});
	});
});
