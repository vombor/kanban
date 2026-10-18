import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createProjectKnowledgeStore } from "../../../src/knowledge/knowledge-store";
import { createPlanBundleStore } from "../../../src/knowledge/plan-bundle-store";
import { createTaskContextApi } from "../../../src/knowledge/task-context-api";
import { buildTaskContextBootstrap } from "../../../src/knowledge/task-context-bootstrap";
import { createTaskContextStore } from "../../../src/knowledge/task-context-store";
import { planBreakdownSchema } from "../../../src/plans/plan-breakdown";
import { createPlanIndexStore, type PlanRecord } from "../../../src/plans/plan-index";
import { startWithTaskContext } from "../../../src/server/task-context-session-admission";
import { getProjectKnowledgePaths } from "../../../src/state/kanban-home";
import type { StartTaskSessionRequest } from "../../../src/terminal/session-manager";
import type { TaskContextAdoptRequest } from "../../../src/trpc/knowledge-execution-contract";
import { taskKnowledgeReadRequestSchema } from "../../../src/trpc/knowledge-execution-contract";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

const USER: RuntimeCaller = { kind: "user" };
const session = (workspaceId: string, role: "card" | "orchestrator" = "card"): RuntimeCaller => ({
	kind: "session",
	session: { workspaceId, role, taskId: "dev1", agentId: "codex", cwd: "/owned-test" },
	via: "credential",
});
async function fixture() {
	const knowledge = createProjectKnowledgeStore();
	const publish = async (id: string, markdown: string, expectedRevision: string | null = null) => {
		const result = await knowledge.mutate(
			"demo",
			{ kind: "user" },
			{
				action: "publish",
				requestId: randomUUID(),
				document: { id, kind: "contract", title: id, summary: "", tags: [], sources: [] },
				markdown,
				expectedRevision,
			},
		);
		if (result.kind !== "document") throw new Error("Expected document");
		return result.document;
	};
	const document = await publish(
		"api-contract",
		`# API contract\n\n## Response\nKeep the reviewed response.\n${"bounded ".repeat(700)}`,
	);
	const protectedDocument = await publish("user-decision", "# Protected decision\nPreserve the user's scope.");
	const pinned = await knowledge.mutate(
		"demo",
		{ kind: "user" },
		{
			action: "pin",
			id: protectedDocument.id,
			pinned: true,
			expectedRevision: protectedDocument.revision,
			requestId: randomUUID(),
		},
	);
	if (pinned.kind !== "document") throw new Error("Expected protected document");
	const bundles = createPlanBundleStore({ knowledge });
	const breakdown = planBreakdownSchema.parse({
		version: 1,
		slug: "feature",
		cards: [
			{
				id: "api",
				title: "Implement API",
				prompt: "Implement and test the reviewed API contract.",
				knowledgeReferences: [{ id: document.id, revision: document.revision }],
				acceptanceCriteria: ["Reviewed response preserved"],
			},
			{
				id: "ui",
				title: "Implement UI",
				prompt: "Implement and test the reviewed UI behavior.",
				dependsOn: ["api"],
				acceptanceCriteria: ["UI verified"],
			},
		],
	});
	const input = {
		planTaskId: "plan1",
		slug: "feature",
		specPath: "docs/specs/feature.md",
		breakdownPath: "docs/specs/feature.cards.json",
		spec: "# Reviewed feature\n\n## Goals\nShip the approved behavior, not a mutable future replacement.\n",
		breakdownText: JSON.stringify(breakdown),
		breakdown,
	};
	const prepared = await bundles.prepare("demo", input);
	const bundle = await bundles.persist("demo", prepared);
	const index = createPlanIndexStore();
	const record: PlanRecord = {
		taskId: "plan1",
		slug: "feature",
		title: "Feature",
		createdAt: "2026-10-18T00:00:00.000Z",
		kit: "team",
		agentId: "claude",
		providerId: null,
		modelId: null,
		startInPlanMode: true,
		approval: {
			at: "2026-10-18T01:00:00.000Z",
			via: "approve",
			breakdownSha256: bundle.breakdown.contentHash,
			bundleRevision: bundle.revision,
		},
		expansion: {
			status: "creating",
			startedAt: "2026-10-18T02:00:00.000Z",
			finishedAt: null,
			breakdownSha256: bundle.breakdown.contentHash,
			bundleRevision: bundle.revision,
			cards: { api: "api1", ui: "ui1" },
			links: [{ waiting: "ui", prerequisite: "api" }],
		},
		metrics: null,
	};
	await index.update("demo", (current) => ({ ...current, plans: { plan1: record } }));
	const contexts = createTaskContextStore({ bundles, index });
	const api = createTaskContextApi({ contexts, bundles, knowledge });
	return {
		knowledge,
		publish,
		document,
		protectedDocument: pinned.document,
		bundles,
		prepared,
		bundle,
		input,
		index,
		record,
		contexts,
		api,
	};
}
async function adoptionFixture() {
	const value = await fixture();
	await value.contexts.attachExpansion("demo", "plan1");
	const context = await value.contexts.read("demo", "api1");
	if (!context) throw new Error("Missing fixture context");
	const replacement = await value.publish(
		value.document.id,
		"# API contract\nExplicitly reviewed replacement.",
		value.document.revision,
	);
	const input: TaskContextAdoptRequest = {
		taskId: "api1",
		requestId: randomUUID(),
		expectedContextRevision: context.revision,
		documentId: value.document.id,
		expectedDocumentRevision: value.document.revision,
		targetRevision: replacement.revision,
		reason: "Use reviewed v2 reference without changing acceptance",
	};
	const api = createTaskContextApi({
		contexts: value.contexts,
		bundles: value.bundles,
		knowledge: value.knowledge,
		admissionAvailable: true,
		canAdopt: async () => true,
	});
	return { ...value, api, context, replacement, adoptionInput: input };
}
const request = (part: "spec" | "breakdown" | "document", extra = {}) =>
	taskKnowledgeReadRequestSchema.parse({ taskId: "api1", part, ...extra });

describe("approved-plan immutable knowledge handoffs", () => {
	it("records one explicit user adoption with historical reads, unchanged plan approval, exact-retry receipts and expansion retries", async () =>
		withTemporaryKanbanHome(async () => {
			const { api, contexts, context, adoptionInput, replacement, index, record } = await adoptionFixture();
			const adopted = await api.adopt(USER, "demo", adoptionInput);
			expect(adopted.duplicate).toBe(false);
			expect(adopted.context.adoption).toMatchObject({
				by: "user",
				parentRevision: context.revision,
				targetRevision: replacement.revision,
				reason: adoptionInput.reason,
			});
			expect(adopted.context.bundleRevision).toBe(context.bundleRevision);
			expect((await index.read("demo")).plans.plan1?.approval).toEqual(record.approval);
			expect((await api.read(USER, "demo", request("document", { id: replacement.id }))).markdown).toContain(
				"Explicitly reviewed replacement",
			);
			expect(
				(
					await api.read(
						USER,
						"demo",
						request("document", { id: replacement.id, contextRevision: context.revision }),
					)
				).markdown,
			).toContain("Keep the reviewed response");
			await contexts.attachExpansion("demo", "plan1");
			expect((await contexts.read("demo", "api1"))?.revision).toBe(adopted.context.revision);
			await contexts.reserveStart("demo", "api1");
			expect(await api.adopt(USER, "demo", adoptionInput)).toMatchObject({
				duplicate: true,
				context: adopted.context,
			});
			await expect(api.adopt(USER, "demo", { ...adoptionInput, reason: "another choice" })).rejects.toMatchObject({
				code: "CONFLICT",
			});
			const view = await api.get(USER, "demo", { taskId: "api1" });
			expect(view.history).toHaveLength(2);
			expect(view.canAdopt).toBe(false);
			expect(view.startReservation?.contextRevision).toBe(adopted.context.revision);
		}));
	it("refuses agents, unknown/cross-project callers and unguarded runtimes even with isolation off", async () =>
		withTemporaryKanbanHome(async () => {
			const { api, contexts, adoptionInput } = await adoptionFixture();
			for (const caller of [
				session("demo"),
				session("demo", "orchestrator"),
				session("other", "orchestrator"),
				{ kind: "unknown", reason: "fixture" } as RuntimeCaller,
			])
				await expect(api.adopt(caller, "demo", adoptionInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(createTaskContextApi({ contexts }).adopt(USER, "demo", adoptionInput)).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
			});
			await expect(contexts.adopt("demo", adoptionInput, async () => false)).rejects.toThrow(/provably unstarted/u);
			expect((await contexts.inspect("demo", "api1")).history).toHaveLength(1);
		}));
	it("refuses stale context/document choices, absent selected refs, and publication races", async () =>
		withTemporaryKanbanHome(async () => {
			const { api, publish, replacement, adoptionInput } = await adoptionFixture();
			await expect(
				api.adopt(USER, "demo", { ...adoptionInput, expectedContextRevision: "f".repeat(64) }),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await expect(
				api.adopt(USER, "demo", { ...adoptionInput, expectedDocumentRevision: "f".repeat(64) }),
			).rejects.toMatchObject({ code: "CONFLICT" });
			await expect(api.adopt(USER, "demo", { ...adoptionInput, taskId: "ui1" })).rejects.toMatchObject({
				code: "CONFLICT",
			});
			await publish(replacement.id, "# API\nNewer than the selected preview.", replacement.revision);
			await expect(api.adopt(USER, "demo", adoptionInput)).rejects.toThrow(/changed since review/u);
		}));
	it("serializes adoption before physical admission and injects the adopted revision, not an earlier preflight pointer", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, adoptionInput, context } = await adoptionFixture();
			let entered!: () => void, release!: () => void;
			const reached = new Promise<void>((resolve) => {
					entered = resolve;
				}),
				gate = new Promise<void>((resolve) => {
					release = resolve;
				});
			const adoption = contexts.adopt("demo", adoptionInput, async () => {
				entered();
				await gate;
				return true;
			});
			await reached;
			let launched: StartTaskSessionRequest | undefined;
			const request: StartTaskSessionRequest = {
				taskId: "api1",
				agentId: "claude",
				binary: "fake",
				args: [],
				cwd: "/owned",
				prompt: "Implement unchanged approved requirements",
			};
			const starting = startWithTaskContext({
				contexts,
				workspaceId: "demo",
				request,
				start: async (prepared) => {
					launched = prepared;
					return {} as RuntimeTaskSessionSummary;
				},
			});
			release();
			const adopted = await adoption;
			await starting;
			expect(launched?.prompt).toContain(adopted.context.revision);
			expect(launched?.prompt).not.toContain(context.revision);
			expect((await contexts.inspect("demo", "api1")).startReservation?.contextRevision).toBe(
				adopted.context.revision,
			);
		}));
	it("freezes context before even a blank/failed physical start and refuses a concurrent adoption with no replay", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, adoptionInput, context } = await adoptionFixture();
			const request: StartTaskSessionRequest = {
				taskId: "api1",
				agentId: "claude",
				binary: "fake",
				args: [],
				cwd: "/owned",
				prompt: "",
			};
			await expect(
				startWithTaskContext({
					contexts,
					workspaceId: "demo",
					request,
					start: async (prepared) => {
						expect(prepared?.prompt).toBe("");
						await expect(contexts.adopt("demo", adoptionInput, async () => true)).rejects.toThrow(/unstarted/u);
						throw new Error("uncertain spawn");
					},
				}),
			).rejects.toThrow("uncertain spawn");
			expect((await contexts.inspect("demo", "api1")).startReservation?.contextRevision).toBe(context.revision);
			await expect(contexts.adopt("demo", adoptionInput, async () => true)).rejects.toThrow(/unstarted/u);
		}));
	it("retains spec/exact JSON/selected and protected revisions, with distinct spec and bundle identities", async () =>
		withTemporaryKanbanHome(async () => {
			const { bundles, bundle, input } = await fixture();
			expect(await bundles.read("demo", bundle.revision)).toEqual(bundle);
			expect(await bundles.readPart("demo", bundle.spec.contentHash)).toBe(input.spec);
			expect(await bundles.readPart("demo", bundle.breakdown.contentHash)).toBe(input.breakdownText);
			expect(bundle.documents.map((item) => item.id)).toEqual(["api-contract", "user-decision"]);
			const changed = await bundles.prepare("demo", { ...input, spec: "# Changed spec" });
			expect(changed.bundle.revision).not.toBe(bundle.revision);
			expect(changed.bundle.breakdown.contentHash).toBe(bundle.breakdown.contentHash);
		}));
	it("attaches all task-specific pins before cards exist, retries exactly, and retains them after board pruning", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, api, bundle } = await fixture();
			await api.attachExpansion(session("demo", "orchestrator"), "demo", { planTaskId: "plan1" });
			const first = await contexts.read("demo", "api1");
			expect(first?.documents.map((item) => item.id)).toEqual(["api-contract", "user-decision"]);
			expect((await contexts.read("demo", "ui1"))?.documents.map((item) => item.id)).toEqual(["user-decision"]);
			await contexts.attachExpansion("demo", "plan1");
			expect(await contexts.read("demo", "api1")).toEqual(first);
			expect(first?.bundleRevision).toBe(bundle.revision);
			// Reads have no board/worktree dependency: a pruned/landed plan or dev card cannot remove its handoff.
			expect((await api.read(USER, "demo", request("spec"))).markdown).toContain("Reviewed feature");
			expect((await stat(join(getProjectKnowledgePaths("demo").root, "task-contexts.json"))).mode & 0o777).toBe(
				0o600,
			);
		}));
	it("reports revision drift without changing pins, and serves bounded sections at the historical context", async () =>
		withTemporaryKanbanHome(async () => {
			const { api, contexts, document, publish } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			const original = await contexts.read("demo", "api1");
			const latest = await publish(document.id, "# API contract\nDifferent future response.", document.revision);
			const result = await api.get(USER, "demo", { taskId: "api1" });
			expect(result.drift).toEqual([{ id: document.id, pinned: document.revision, current: latest.revision }]);
			expect(result.context).toEqual(original);
			const first = await api.read(
				session("demo"),
				"demo",
				request("document", {
					id: document.id,
					contextRevision: original?.revision,
					section: "response",
					limit: 128,
				}),
			);
			expect(first.markdown).toContain("Keep the reviewed response.");
			expect(first.markdown.length).toBeLessThanOrEqual(128);
			expect(first.nextOffset).not.toBeNull();
			const next = await api.read(
				USER,
				"demo",
				request("document", {
					id: document.id,
					contextRevision: first.contextRevision,
					section: "response",
					offset: first.nextOffset,
					limit: 128,
				}),
			);
			expect(next.offset).toBe(first.nextOffset);
			expect((await api.read(USER, "demo", request("breakdown"))).contentHash).not.toBe(first.contentHash);
		}));
	it("has strict own-project privacy even with isolation off, and no arbitrary-hash/document fallback", async () =>
		withTemporaryKanbanHome(async () => {
			const { api, contexts } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			for (const caller of [
				session("other", "orchestrator"),
				{ kind: "unknown", reason: "no strict identity" } as RuntimeCaller,
			]) {
				await expect(api.get(caller, "demo", { taskId: "api1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(api.read(caller, "demo", request("spec"))).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(api.attachExpansion(caller, "demo", { planTaskId: "plan1" })).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
			}
			await expect(api.attachExpansion(session("demo"), "demo", { planTaskId: "plan1" })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(api.read(USER, "demo", request("document", { id: "not-pinned" }))).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			await expect(
				api.read(USER, "demo", request("spec", { contextRevision: "f".repeat(64) })),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(
				taskKnowledgeReadRequestSchema.safeParse({ taskId: "api1", part: "spec", contentHash: "f".repeat(64) })
					.success,
			).toBe(false);
			for (const taskId of ["constructor", "toString", "prototype", "../other"])
				expect(taskKnowledgeReadRequestSchema.safeParse({ taskId, part: "spec" }).success).toBe(false);
		}));
	it("ordinary publication/bundle retention and historical breakdown-only approvals cannot attach execution contexts", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, index, record } = await fixture();
			await index.update("demo", (current) => ({
				...current,
				plans: {
					plan1: {
						...record,
						expansion: null,
						approval: {
							at: "2026-10-01",
							via: "approve",
							breakdownSha256: record.approval?.breakdownSha256 ?? "",
						},
					},
				},
			}));
			await expect(contexts.attachExpansion("demo", "plan1")).rejects.toThrow(/exact approved/u);
			expect(await contexts.read("demo", "api1")).toBeNull();
		}));
	it("rejects missing specs, invented revisions, conflicting selections and shadowed user pins", async () =>
		withTemporaryKanbanHome(async () => {
			const { bundles, input, document, protectedDocument } = await fixture();
			await expect(bundles.prepare("demo", { ...input, spec: null })).rejects.toThrow(/spec is missing/u);
			for (const references of [
				[{ id: "unknown", revision: "f".repeat(64) }],
				[
					{ id: document.id, revision: document.revision },
					{ id: document.id, revision: "f".repeat(64) },
				],
				[{ id: protectedDocument.id, revision: "f".repeat(64) }],
			]) {
				const breakdown = { ...input.breakdown, knowledgeReferences: references };
				await expect(
					bundles.prepare("demo", { ...input, breakdown, breakdownText: JSON.stringify(breakdown) }),
				).rejects.toThrow();
			}
		}));
	it("refuses missing/corrupt retained objects and damaged task contexts instead of fallback or eviction", async () =>
		withTemporaryKanbanHome(async () => {
			const { bundles, contexts, bundle, api } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			const paths = getProjectKnowledgePaths("demo");
			await writeFile(join(paths.objects, `${bundle.spec.contentHash}.md`), "corrupt");
			await expect(api.read(USER, "demo", request("spec"))).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
			await rm(join(paths.objects, `${bundle.revision}.md`));
			await expect(bundles.read("demo", bundle.revision)).rejects.toThrow(/missing or unreadable/u);
			const contextFile = join(paths.root, "task-contexts.json");
			await writeFile(contextFile, "");
			await expect(contexts.attachExpansion("demo", "plan1")).rejects.toThrow();
			expect(await readFile(contextFile, "utf8")).toBe("");
		}));
	it("builds a small stable pointer, not the spec/documents or permission", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, input } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			const pointer = await buildTaskContextBootstrap(contexts, "demo", "api1");
			expect(pointer).toContain("--context-revision");
			expect(pointer).toContain("not a new approval");
			expect(pointer).not.toContain(input.spec);
			expect(pointer.length).toBeLessThan(1000);
			expect(await buildTaskContextBootstrap(contexts, "demo", "ordinary1")).toBe("");
		}));
	it("refuses a missing reserved handoff and never writes over damaged pin history", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, api } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			const file = join(getProjectKnowledgePaths("demo").root, "task-contexts.json");
			await writeFile(file, "damaged retained pins");
			await expect(contexts.attachExpansion("demo", "plan1")).rejects.toThrow(/damaged/u);
			expect(await readFile(file, "utf8")).toBe("damaged retained pins");
			await rm(file);
			await expect(api.get(USER, "demo", { taskId: "api1" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
			expect(await contexts.read("demo", "ordinary-session:legacy")).toBeNull();
		}));
});
