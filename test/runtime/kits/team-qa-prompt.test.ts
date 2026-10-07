import { describe, expect, it } from "vitest";

import { getPreviousQaRounds } from "../../../src/pipeline/qa-log";
import { buildQaPrompt, buildQaRequirements, getQaShortTitle } from "../../../src/pipeline/qa-prompt";
import { getSnapshotRef } from "../../../src/pipeline/snapshots";

import { createCardHistory } from "../../utilities/effective-card";
import {
	createTeamPolicy,
	getFooImportedOverrides,
	LEGACY_QA_OUT_ROOT,
	readLegacyQaPrompts,
	toFooEffectiveCard,
} from "../../utilities/legacy-team-fixtures";

// foo's QA prompt parts from the `team` kit + foo's imported overrides, checked against the legacy kit's own prompts
// (archive/devteam-kit:qa/qa-card.cjs@9828540 buildPrompt, fixtures in fixtures/legacy-team/qa-prompts.json). The kit
// owns the parts (rule texts, blurb, notes); the skeleton around them is the core's QA prompt builder.

/** The legacy kit's qaScratchRoot default (lib/config.cjs DEFAULTS); the live file does not set it. */
const LEGACY_QA_SCRATCH_ROOT = "/tmp/qa-claude";
describe("team kit QA prompt parts for foo", () => {
	for (const fixture of readLegacyQaPrompts()) {
		describe(fixture.name, () => {
			const answer = createTeamPolicy(getFooImportedOverrides()).qaPolicy({
				dev: toFooEffectiveCard(fixture.card),
				round: fixture.round,
				history: createCardHistory(),
			});
			if (answer.kind !== "qa") {
				throw new Error(`expected a QA answer, got: ${answer.reason}`);
			}
			const { promptParts } = answer;
			const outbox = `${LEGACY_QA_OUT_ROOT}/${fixture.qaId}`;

			it("has the legacy step-3 rules, in order, with {outbox} filled in", () => {
				expect(promptParts.rules).toHaveLength(fixture.rules.length);
				// Each rule is its own step-3 item after g. (h., i., …), right before step 4.
				const items = promptParts.rules
					.map((rule, index) => `\n   ${String.fromCharCode(104 + index)}. ${rule.replaceAll("{outbox}", outbox)}`)
					.join("");
				expect(fixture.prompt).toContain(`${items}\n4. JUDGE`);
				if (promptParts.rules.length === 0) {
					expect(fixture.prompt).toContain("stops them after your verdict.\n4. JUDGE");
					expect(fixture.prompt).not.toContain("DRIVE THE CHANGED PATH");
				}
			});

			it("puts the blurb first in the requirements unless the dev prompt names its project", () => {
				const requirements = fixture.prompt.slice(fixture.prompt.lastIndexOf('requirements:\n"""\n'));
				expect(requirements.includes(promptParts.blurb)).toBe(!/\bProject:/u.test(fixture.card.prompt));
			});

			it("gives the scratch copy foo's seeded database", () => {
				expect(promptParts.notes.dbSetup).not.toBe("");
				expect(fixture.prompt).toContain(`&& ${promptParts.notes.dbSetup})`);
				expect(promptParts.notes.knownBaseIssues).toBe("");
				expect(promptParts.notes.screenshotFallback).toBe("");
				expect(promptParts.serversScript).toBeNull();
			});
		});
	}

	// The whole prompt: the core skeleton (src/pipeline/qa-prompt.ts) around the kit's parts, built the way the QA
	// gate builds it, equals qa-card.cjs's for every fixture. The legacy roots differ from the fork defaults
	// (outbox /tmp/qa-out, scratch /tmp/qa-claude), so they are passed explicitly, as is the legacy kit home.
	for (const fixture of readLegacyQaPrompts()) {
		it(`builds exactly the legacy qa-card.cjs prompt: ${fixture.name}`, () => {
			const answer = createTeamPolicy(getFooImportedOverrides()).qaPolicy({
				dev: toFooEffectiveCard(fixture.card),
				round: fixture.round,
				history: createCardHistory(),
			});
			if (answer.kind !== "qa") {
				throw new Error(`expected a QA answer, got: ${answer.reason}`);
			}
			const prompt = buildQaPrompt({
				devTaskId: fixture.card.id,
				round: fixture.round,
				devTitle: fixture.card.title || fixture.card.prompt,
				requirements: buildQaRequirements(fixture.card.prompt, answer.promptParts.blurb),
				repoPath: "/projects/foo",
				snapshotRef: getSnapshotRef(fixture.card.id),
				baseRef: "master",
				scratchDir: `${LEGACY_QA_SCRATCH_ROOT}/${fixture.card.id}`,
				outboxDir: `${LEGACY_QA_OUT_ROOT}/${fixture.qaId}`,
				previousRounds: getPreviousQaRounds(fixture.qaLog, fixture.card.id),
				parts: answer.promptParts,
				kanbanHome: "~/.kanban",
			});
			expect(getQaShortTitle(fixture.card.title || fixture.card.prompt)).toBe(fixture.short);
			expect(prompt).toBe(fixture.prompt);
		});
	}
});
