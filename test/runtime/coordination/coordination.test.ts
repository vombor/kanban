import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { type CoordinationSource, createCoordinationApi } from "../../../src/coordination/coordination-api";
import { readCoordinationSnapshot } from "../../../src/coordination/snapshot-paths";
import { coordinationPathSchema } from "../../../src/core/coordination-hints";
import { createPlanBundleStore } from "../../../src/knowledge/plan-bundle-store";
import { takeTaskSnapshot } from "../../../src/pipeline/snapshots";
import { parsePlanBreakdown } from "../../../src/plans/plan-breakdown";
import { planRecordSchema } from "../../../src/plans/plan-index";
import { createGitTestEnv } from "../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";
import { createBoard, createCard } from "../../utilities/workspace-state-store";

const source = (): CoordinationSource => ({
	repoPath: "/fixture",
	board: createBoard({
		backlog: [
			createCard({
				id: "dev1",
				agentSettings: { providerId: "lemonade", modelId: "Ornith-1.5-35B-A3B-GGUF-Q4_K_M" },
			}),
			createCard({ id: "dev2", agentSettings: { providerId: "lemonade", modelId: "MuseGlimmer-Q4-DFlash-Test" } }),
		],
	}),
	sessions: [],
	stages: [],
	selectedAgentId: "cline",
	agentDefaultModels: {},
	config: parsePipelineConfig({
		providerConcurrency: { lemonade: 1 },
		models: { providerCapacity: { lemonade: { maxLoadedModels: 1 } } },
	}).config,
});
const snapshot = vi.fn(async () => ({
	snapshot: "a".repeat(40),
	baseCommit: "b".repeat(40),
	observedPaths: ["src/shared.ts"],
	pathsTruncated: false,
}));
const noBundles = {
	read: vi.fn(async () => {
		throw new Error("not requested");
	}),
	readPart: vi.fn(async () => {
		throw new Error("not requested");
	}),
};

describe("advisory coordination", () => {
	it("requires strict own-project authorization before reading any source", async () => {
		const load = vi.fn(async () => source());
		const api = createCoordinationApi({
			load,
			plans: { read: async () => ({ version: 1, plans: {} }) },
			bundles: noBundles,
			capacity: { check: async () => ({ hold: null }) },
			snapshot,
		});
		await expect(api.preview({ kind: "unknown", reason: "fixture" }, "own", {})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			api.preview(
				{
					kind: "session",
					via: "credential",
					session: { workspaceId: "other", role: "card", taskId: "task1", agentId: "claude", cwd: "/other" },
				},
				"own",
				{},
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(load).not.toHaveBeenCalled();
	});
	it("reads native prerequisites, preserves missing/Done-deleted semantics and never converts advice into links or starts", async () => {
		const input = source();
		input.board.dependencies = [
			{ id: "edge1", fromTaskId: "dev1", toTaskId: "gone", createdAt: 1 },
			{ id: "edge2", fromTaskId: "dev2", toTaskId: "doneGone", createdAt: 1, doneTaskDeletedAt: 2 },
		];
		const before = JSON.stringify(input),
			api = createCoordinationApi({
				load: async () => input,
				plans: { read: async () => ({ version: 1, plans: {} }) },
				bundles: noBundles,
				capacity: { check: async () => ({ hold: null }) },
				snapshot,
			});
		const report = await api.preview({ kind: "user" }, "own", {});
		expect(report.tasks.map((t) => t.readiness)).toEqual(["missing_prerequisite", "prerequisites_satisfied"]);
		expect(report.advice).toMatchObject([
			{ kind: "path_overlap", basis: "retained_snapshots" },
			{ kind: "provider_serialization", basis: "configured_capacity" },
		]);
		expect(report.dependencies).toHaveLength(2);
		expect(JSON.stringify(input)).toBe(before);
		expect(report.authority).toContain("advisory_only");
		expect(report.warnings).toContain("advisory_not_start_authorization");
	});
	it("keeps existing stage/admission holds and privacy-safe other-project counts distinct from satisfied prerequisites", async () => {
		const input = source();
		input.stages = [
			{
				taskId: "dev1",
				kind: "held",
				label: "Held",
				detail: null,
				deadline: null,
				inFlight: false,
				next: null,
				qaTaskId: null,
				detailTimes: [],
			},
		];
		const api = createCoordinationApi({
			load: async () => input,
			plans: { read: async () => ({ version: 1, plans: {} }) },
			bundles: noBundles,
			capacity: {
				check: async () => ({
					hold: {
						provider: "lemonade",
						maxLoadedModels: 1,
						loadedModels: 1,
						holders: [],
						otherWorkspaceHolders: 2,
					},
				}),
			},
			snapshot,
		});
		const report = await api.preview({ kind: "user" }, "own", {});
		expect(report.tasks[0]).toMatchObject({
			readiness: "blocked_or_unknown",
			ownerStates: ["held"],
			capacityHold: true,
			otherProjectHolders: 2,
		});
		expect(JSON.stringify(report)).not.toContain("privateTask");
	});
	it("reads ownership/interface hints only from the exact approved bundle without expanding or starting a plan", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const bundles = createPlanBundleStore({ homePath }),
				breakdownText = JSON.stringify({
					version: 1,
					slug: "owned",
					cards: [
						{
							id: "producer",
							title: "Producer",
							prompt: "Implement the reviewed shared contract producer.",
							acceptanceCriteria: ["Works"],
							coordination: { paths: ["src/api"], produces: ["interface:v1"] },
						},
						{
							id: "consumer",
							title: "Consumer",
							prompt: "Implement the reviewed shared contract consumer.",
							acceptanceCriteria: ["Works"],
							coordination: { paths: ["src/api/client.ts"], consumes: ["interface:v1"] },
						},
					],
				});
			const parsed = parsePlanBreakdown(breakdownText);
			if (!parsed.ok) throw new Error("Invalid fixture");
			const prepared = await bundles.prepare("own", {
				planTaskId: "plan1",
				slug: "owned",
				specPath: "docs/specs/owned.md",
				breakdownPath: "docs/specs/owned.cards.json",
				spec: "# Owned plan\nReviewed immutable content.",
				breakdownText,
				breakdown: parsed.breakdown,
			});
			await bundles.persist("own", prepared);
			const plan = planRecordSchema.parse({
				taskId: "plan1",
				slug: "owned",
				title: "Owned",
				createdAt: "2026-10-18T00:00:00.000Z",
				kit: "team",
				agentId: "cline",
				providerId: null,
				modelId: null,
				startInPlanMode: true,
				approval: {
					at: "2026-10-18T00:00:00.000Z",
					via: "approve",
					breakdownSha256: prepared.bundle.breakdown.contentHash,
					bundleRevision: prepared.bundle.revision,
				},
				expansion: null,
				metrics: null,
			});
			const capacity = vi.fn(async () => ({ hold: null }));
			const api = createCoordinationApi({
				load: async () => source(),
				plans: { read: async () => ({ version: 1, plans: { plan1: plan } }) },
				bundles,
				capacity: { check: capacity },
				snapshot,
			});
			const report = await api.preview({ kind: "user" }, "own", { planTaskId: "plan1" });
			expect(report.tasks.map((t) => t.readiness)).toEqual(["planned_only", "planned_only"]);
			expect(report.dependencies).toEqual([]);
			expect(report.advice.map((a) => a.kind)).toEqual(["path_overlap", "contract_dependency"]);
			expect(report.approvedBundle).toBe(prepared.bundle.revision);
			expect(capacity).not.toHaveBeenCalled();
			if (!plan.approval) throw new Error("Missing fixture approval");
			plan.approval = { ...plan.approval, breakdownSha256: "f".repeat(64) };
			await expect(api.preview({ kind: "user" }, "own", { planTaskId: "plan1" })).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
		}));
	it("supports old breakdowns but refuses unsafe/unbounded ownership hints", () => {
		for (const path of ["../private", "/etc/passwd", "src\\file", "src/*", "src/\u001bname", "file:stream"])
			expect(coordinationPathSchema.safeParse(path).success).toBe(false);
		expect(coordinationPathSchema.safeParse(".github/workflows").success).toBe(true);
	});
	it("observes retained paths only and leaves mutable work, HEAD, refs and index unchanged", async () => {
		const temp = createTempDir("coordination-snapshot-");
		try {
			const git = (...args: string[]) =>
				execFileSync("git", args, { cwd: temp.path, env: createGitTestEnv(), encoding: "utf8" }).trim();
			git("init", "-b", "main");
			git("config", "user.name", "Fixture");
			git("config", "user.email", "fixture@example.invalid");
			await writeFile(join(temp.path, "original.txt"), "base\n");
			git("add", ".");
			git("commit", "-m", "base");
			await writeFile(join(temp.path, "original.txt"), "changed\n");
			await takeTaskSnapshot({
				worktreePath: temp.path,
				taskId: "dev1",
				baseRef: "main",
				reason: "fixture",
				dryRun: false,
			});
			await writeFile(join(temp.path, "unsubmitted.txt"), "not snapshotted\n");
			const before = {
				head: git("rev-parse", "HEAD"),
				refs: git("show-ref"),
				index: await readFile(join(temp.path, ".git/index")),
				status: git("status", "--porcelain"),
			};
			const result = await readCoordinationSnapshot(temp.path, "dev1", "main");
			expect(result.observedPaths).toEqual(["original.txt"]);
			expect(result.pathsTruncated).toBe(false);
			expect({
				head: git("rev-parse", "HEAD"),
				refs: git("show-ref"),
				index: await readFile(join(temp.path, ".git/index")),
				status: git("status", "--porcelain"),
			}).toEqual(before);
		} finally {
			temp.cleanup();
		}
	});
});
