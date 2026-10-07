import { describe, expect, it } from "vitest";
import {
	findImplicitLegacyToggleWarnings,
	type LegacyKitProcessProbe,
	type LegacyKitService,
	readLegacyKitServices,
} from "../../../src/config/legacy-kit-config";
import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import type { DoctorFinding } from "../../../src/doctor/doctor-report";
import { checkOneOwner, type OneOwnerContext } from "../../../src/doctor/one-owner-checks";

const LEGACY_KIT_PATH = "/kit/kit.config.json";

// By default column-sync is retired (as after the P2 cutover), so only the row under test can fail.
function services(overrides: Partial<Record<LegacyKitService["name"], Partial<LegacyKitService>>> = {}) {
	return (["autoland", "column-sync", "review-watch", "model-lists"] as const).map((name, index) => ({
		name,
		disabled: name === "column-sync",
		pid: name === "column-sync" ? null : 100 + index,
		...overrides[name],
	}));
}

function board(cards: Array<{ id: string; column: string; autoReviewEnabled?: boolean }>): RuntimeBoardData {
	const columns = ["backlog", "in_progress", "review", "trash"].map((id) => ({
		id,
		title: id,
		cards: cards
			.filter((card) => card.column === id)
			.map((card) => ({
				id: card.id,
				title: card.id,
				prompt: "",
				startInPlanMode: false,
				autoReviewEnabled: card.autoReviewEnabled,
				baseRef: "main",
				createdAt: 0,
				updatedAt: 0,
			})),
	}));
	return { columns, dependencies: [] } as unknown as RuntimeBoardData;
}

const fooProject = {
	workspaceId: "foo",
	projectPath: "/projects/foo",
	toggles: { QA_CREATE: true, AUTO_REWORK: true, AUTO_DONE: true },
};

function context(
	overrides: Partial<OneOwnerContext> & { kanbanConfig?: unknown; kit?: unknown } = {},
): OneOwnerContext {
	return {
		legacyKit: {
			path: LEGACY_KIT_PATH,
			raw: (overrides.kit ?? { runDir: "/kit/run", projects: [fooProject] }) as Record<string, unknown>,
			error: null,
		},
		services: services(),
		config: parsePipelineConfig(overrides.kanbanConfig ?? {}).config,
		entries: [{ workspaceId: "foo", repoPath: "/projects/foo" }],
		loadBoard: async () => board([]),
		clineModelsSourceUrl: null,
		...overrides,
	};
}

function levels(findings: DoctorFinding[]): Array<[string, string]> {
	return findings.map((finding) => [finding.level, finding.message]);
}

describe("one-owner check", () => {
	it("passes when there is no legacy kit", async () => {
		const findings = await checkOneOwner(
			context({
				legacyKit: { path: LEGACY_KIT_PATH, raw: null, error: null },
				kanbanConfig: { agents: { cline: { turnDetector: { mode: "on" } } }, watchdog: { mode: "on" } },
			}),
		);
		// Recovery is report-only by default: an info row, not a failure.
		expect(findings.map((finding) => finding.level)).toEqual(["pass", "pass", "pass", "pass", "info"]);
	});

	it("fails when Kanban's watchdog is on while review-watch runs; report mode is the designed overlap", async () => {
		const on = await checkOneOwner(context({ kanbanConfig: { watchdog: { mode: "on" } } }));
		expect(on.find((finding) => finding.message.includes("review-watch") && finding.level === "fail")).toMatchObject({
			message:
				"two owners for stall detection, ATTENTION.md and orchestrator wakes: Kanban's watchdog (watchdog.mode on) and the legacy kit's review-watch",
			hint: 'touch /kit/run/review-watch.disabled && kit stop review-watch, or set watchdog.mode to "report" in config.json',
		});
		const report = await checkOneOwner(context({ kanbanConfig: { watchdog: { mode: "report" } } }));
		expect(levels(report)).toContainEqual([
			"info",
			"the legacy kit's review-watch watches the boards and wakes the orchestrator; Kanban's watchdog is report (logs to data/<workspace>/watchdog-decisions.jsonl only)",
		]);
		const retired = await checkOneOwner(
			context({
				services: services({ "review-watch": { pid: null, disabled: true } }),
				kanbanConfig: { watchdog: { mode: "on" } },
			}),
		);
		expect(levels(retired)).toContainEqual([
			"pass",
			"Kanban's watchdog watches the boards and wakes the orchestrator",
		]);
	});

	it("fails when Kanban's recovery and the kit's autoland both recover a project", async () => {
		const recoveryOn = { pipeline: { recovery: { mode: "on" } } };
		const both = await checkOneOwner(context({ kanbanConfig: recoveryOn }));
		expect(both.find((finding) => finding.message.includes("recovery"))).toMatchObject({
			level: "fail",
			message: expect.stringContaining("two owners for recovery (nudges, provider retries, restart resumes) on foo"),
			hint: expect.stringContaining("touch /kit/run/autoland.disabled && kit stop autoland"),
		});
		// A shadow workspace or recovery switched off for it only logs: no second owner.
		for (const workspace of [{ pipeline: { shadow: true } }, { recovery: { enabled: false } }]) {
			const logged = await checkOneOwner(
				context({ kanbanConfig: { ...recoveryOn, workspaces: { foo: workspace } } }),
			);
			expect(logged.filter((finding) => finding.level === "fail")).toEqual([]);
		}
		// The default ("report") leaves recovery to autoland.
		expect(levels(await checkOneOwner(context()))).toContainEqual([
			"info",
			"the legacy kit's autoland recovers crashed and orphaned cards; Kanban's recovery is report (decides and logs only)",
		]);
		// autoland retired and recovery on: Kanban owns it.
		const retired = services({ autoland: { pid: null, disabled: true } });
		expect(levels(await checkOneOwner(context({ services: retired, kanbanConfig: recoveryOn })))).toContainEqual([
			"pass",
			"Kanban recovers crashed and orphaned cards on foo (pipeline.recovery.mode on)",
		]);
		// autoland retired and recovery still report-only: nothing recovers the kit's projects.
		expect(
			(await checkOneOwner(context({ services: retired }))).find((finding) =>
				finding.message.startsWith("nothing nudges crashed cards"),
			)?.level,
		).toBe("warn");
	});

	it("fails when Kanban's session sync and the kit's column-sync both move cards", async () => {
		const running = services({ "column-sync": { pid: 300, disabled: false } });
		const both = await checkOneOwner(context({ services: running }));
		expect(both.find((finding) => finding.level === "fail")).toMatchObject({
			message: expect.stringContaining("two owners for In Progress ↔ Review moves"),
			hint: 'touch /kit/run/column-sync.disabled && kit stop column-sync, or set "sessionSync": { "enabled": false } in config.json',
		});
		// P2-1's boolean form switches it off the same way.
		for (const sessionSync of [false, { enabled: false }]) {
			const kitOnly = await checkOneOwner(context({ services: running, kanbanConfig: { sessionSync } }));
			expect(kitOnly.some((finding) => finding.level === "fail")).toBe(false);
			expect(levels(kitOnly)).toContainEqual([
				"info",
				"the legacy kit's column-sync moves cards between In Progress and Review; Kanban's session sync is off",
			]);
		}
	});

	it("fails when the Cline turn detector is on while column-sync still ends turns; report mode is the designed overlap", async () => {
		const running = services({ "column-sync": { pid: 300, disabled: false } });
		const on = await checkOneOwner(
			context({
				services: running,
				kanbanConfig: { sessionSync: false, agents: { cline: { turnDetector: { mode: "on" } } } },
			}),
		);
		expect(on.filter((finding) => finding.level === "fail").map((finding) => finding.message)).toEqual([
			"two owners for ending Cline CLI turns: the turn detector (agents.cline.turnDetector.mode on) and the legacy kit's column-sync",
		]);
		const report = await checkOneOwner(context({ services: running, kanbanConfig: { sessionSync: false } }));
		expect(levels(report)).toContainEqual([
			"pass",
			"Cline CLI turns are ended by the legacy kit's column-sync (turn detector: report)",
		]);
	});

	it("warns when column-sync is retired but the turn detector still only reports", async () => {
		const findings = await checkOneOwner(context());
		expect(findings.find((finding) => finding.message.startsWith("nothing ends a Cline CLI turn"))).toMatchObject({
			level: "warn",
			hint: 'set agents.cline.turnDetector.mode to "on" in config.json',
		});
	});

	it("fails when the legacy kit and Kanban both land a project", async () => {
		const findings = await checkOneOwner(
			context({ kanbanConfig: { workspaces: { foo: { landing: { mode: "qa" } } } } }),
		);
		const fail = findings.find((finding) => finding.level === "fail");
		expect(fail?.message).toBe(
			"two owners for landing on foo: the legacy kit (QA_CREATE, AUTO_REWORK, AUTO_DONE) and Kanban (landing qa)",
		);
	});

	it("is fine while Kanban shadows the kit, or when the kit's autoland is switched off", async () => {
		const shadow = await checkOneOwner(
			context({
				kanbanConfig: {
					workspaces: { foo: { landing: { mode: "qa" }, pipeline: { shadow: true }, kit: { name: "team" } } },
				},
			}),
		);
		expect(shadow.some((finding) => finding.level === "fail")).toBe(false);
		expect(levels(shadow)).toContainEqual([
			"info",
			"foo: the legacy kit lands; Kanban shadows it (landing qa, kit team, pipeline.shadow)",
		]);
		const disabled = await checkOneOwner(
			context({
				services: services({ autoland: { pid: null, disabled: true } }),
				kanbanConfig: { workspaces: { foo: { landing: { mode: "qa" } } } },
			}),
		);
		expect(disabled.some((finding) => finding.level === "fail")).toBe(false);
	});

	it("counts a stopped but not disabled service as an owner (it is restarted)", async () => {
		const findings = await checkOneOwner(
			context({
				services: services({ autoland: { pid: null, disabled: false } }),
				kanbanConfig: { workspaces: { foo: { landing: { mode: "commit" } } } },
			}),
		);
		expect(findings.some((finding) => finding.level === "fail")).toBe(true);
	});

	it("points at import-kit when only the kit lands a project", async () => {
		const findings = await checkOneOwner(context());
		expect(findings).toContainEqual(
			expect.objectContaining({
				level: "info",
				message:
					"foo: the legacy kit lands (QA_CREATE, AUTO_REWORK, AUTO_DONE); Kanban's config has landing off, kit default for it",
				hint: "kanban config import-kit --dry-run (maps it to a kit, in shadow)",
			}),
		);
	});

	it("fails on open cards with Kanban auto-review on in a project the kit lands", async () => {
		const findings = await checkOneOwner(
			context({
				loadBoard: async () =>
					board([
						{ id: "aaaaa", column: "review", autoReviewEnabled: true },
						{ id: "bbbbb", column: "in_progress", autoReviewEnabled: false },
						{ id: "ccccc", column: "trash", autoReviewEnabled: true },
					]),
			}),
		);
		const fail = findings.find((finding) => finding.level === "fail");
		expect(fail?.message).toContain("1 card(s) have Kanban auto-review on");
		expect(fail?.message).toContain("aaaaa (commit)");
		expect(fail?.message).not.toContain("ccccc");
	});

	it("ignores projects whose toggles are off: no landing owner, no card check", async () => {
		let loaded = false;
		const findings = await checkOneOwner(
			context({
				kit: { projects: [{ workspaceId: "foo", toggles: { QA_CREATE: false, AUTO_DONE: false } }] },
				kanbanConfig: { workspaces: { foo: { landing: { mode: "commit" } } } },
				loadBoard: async () => {
					loaded = true;
					return board([]);
				},
			}),
		);
		expect(findings.filter((finding) => finding.level === "fail" || /landing|lands/u.test(finding.message))).toEqual(
			[],
		);
		expect(loaded).toBe(false);
	});

	it("fails when Kanban lands before Done on a project autoland still watches, whatever its toggles", async () => {
		// Autoland lands every Review → Done of a configured project from the trashed-task patch.
		const kit = {
			projects: [{ workspaceId: "foo", toggles: { QA_CREATE: false, AUTO_REWORK: false, AUTO_DONE: false } }],
		};
		const qa = await checkOneOwner(
			context({ kit, kanbanConfig: { workspaces: { foo: { landing: { mode: "qa" } } } } }),
		);
		expect(qa.find((finding) => finding.level === "fail")?.message).toBe(
			"two owners for landing on foo: Kanban lands before Done (landing qa) and the legacy kit's autoland lands every Review → Done of a configured project",
		);
		const shadow = await checkOneOwner(
			context({
				kit,
				kanbanConfig: { workspaces: { foo: { landing: { mode: "qa" }, pipeline: { shadow: true } } } },
			}),
		);
		expect(shadow.some((finding) => finding.level === "fail")).toBe(false);
		const stopped = await checkOneOwner(
			context({
				kit,
				services: services({ autoland: { pid: null, disabled: true } }),
				kanbanConfig: { workspaces: { foo: { landing: { mode: "qa" } } } },
			}),
		);
		expect(stopped.some((finding) => finding.level === "fail")).toBe(false);
	});

	it("reports K-1 toggles a project used to inherit from the top level", async () => {
		const kit = { toggles: { QA_CREATE: true }, projects: [{ workspaceId: "bar" }] };
		expect(findImplicitLegacyToggleWarnings(kit)).toEqual([
			"project bar: top-level toggles.QA_CREATE=true no longer applies to it (K-1: off unless the project entry sets it); set projects[].toggles.QA_CREATE explicitly",
		]);
		const findings = await checkOneOwner(context({ kit }));
		expect(findings.filter((finding) => finding.level === "warn").map((finding) => finding.message)).toContain(
			"legacy kit project bar is not a Kanban project on this home",
		);
	});

	it("checks who serves Cline's Lemonade model list", async () => {
		const legacyUrl = "http://127.0.0.1:13306/lemonade/models";
		const down = await checkOneOwner(
			context({
				clineModelsSourceUrl: legacyUrl,
				services: services({ "model-lists": { pid: null, disabled: true } }),
			}),
		);
		expect(down.find((finding) => finding.level === "fail")?.message).toContain("which is not running");
		const both = await checkOneOwner(
			context({ clineModelsSourceUrl: "http://127.0.0.1:3485/api/model-lists/lemonade" }),
		);
		expect(both.find((finding) => finding.level === "warn")?.hint).toBe(
			"touch /kit/run/model-lists.disabled && kit stop model-lists",
		);
		const retired = await checkOneOwner(
			context({
				clineModelsSourceUrl: "http://127.0.0.1:3485/api/model-lists/lemonade",
				services: services({ "model-lists": { pid: null, disabled: true } }),
			}),
		);
		expect(retired.some((finding) => finding.message.includes("model list"))).toBe(false);
	});
});

describe("legacy kit services", () => {
	function probe(
		files: Record<string, string>,
		alive: number[],
		commandLines: Record<number, string[]>,
	): LegacyKitProcessProbe {
		return {
			readFile: (path) => files[path] ?? null,
			isAlive: (pid) => alive.includes(pid),
			readCommandLine: (pid) => commandLines[pid] ?? null,
		};
	}

	it("reads pid files and .disabled switches, and doesn't take a reused pid for the service", () => {
		const raw = { runDir: "/kit/run" };
		const result = readLegacyKitServices(
			raw,
			probe(
				{
					"/kit/run/kanban-autoland.pid": "200\n",
					"/kit/run/kanban-column-sync.pid": "201",
					"/kit/run/column-sync.disabled": "",
					"/kit/run/review-watch.pid": "202",
					"/kit/run/model-lists.pid": "999",
				},
				[200, 201, 202],
				{ 200: ["node", "/kit/services/kanban-autoland.mjs"], 202: ["vim", "notes.txt"] },
			),
		);
		expect(result).toEqual([
			{ name: "autoland", disabled: false, pid: 200 },
			// No readable command line (not Linux): the live pid counts.
			{ name: "column-sync", disabled: true, pid: 201 },
			{ name: "review-watch", disabled: false, pid: null },
			{ name: "model-lists", disabled: false, pid: null },
		]);
	});
});
