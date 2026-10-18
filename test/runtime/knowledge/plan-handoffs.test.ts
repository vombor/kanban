import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readKnowledgeMarkdown } from "../../../src/commands/knowledge";
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
	it("retains exact adopted refs through QA, escalation and runoff inheritance before any child exists", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, api, adoptionInput, replacement, context } = await adoptionFixture();
			const adopted = await api.adopt(USER, "demo", adoptionInput);
			const qa = await contexts.attachDerived("demo", "qa1", {
				sourceTaskId: "api1",
				kind: "qa",
				snapshot: "a".repeat(40),
			});
			expect(qa?.documents).toEqual(adopted.context.documents);
			expect(qa?.inheritance).toEqual({
				sourceTaskId: "api1",
				sourceContextRevision: adopted.context.revision,
				kind: "qa",
				snapshot: "a".repeat(40),
			});
			const escalation = await contexts.attachDerived("demo", "rescue1", {
				sourceTaskId: "api1",
				kind: "escalation",
			});
			const runoff = await contexts.attachDerived("demo", "racer1", { sourceTaskId: "rescue1", kind: "runoff" });
			expect(escalation?.documents).toEqual(qa?.documents);
			expect(runoff?.documents).toEqual(qa?.documents);
			expect(runoff?.bundleRevision).toBe(context.bundleRevision);
			expect(runoff?.adoption).toBeUndefined();
			expect(
				(
					await api.read(
						USER,
						"demo",
						taskKnowledgeReadRequestSchema.parse({ taskId: "racer1", part: "document", id: replacement.id }),
					)
				).markdown,
			).toContain("Explicitly reviewed replacement");
			expect(
				await contexts.attachDerived("demo", "qa1", { sourceTaskId: "api1", kind: "qa", snapshot: "a".repeat(40) }),
			).toEqual(qa);
			await expect(
				contexts.attachDerived("demo", "qa1", { sourceTaskId: "api1", kind: "qa", snapshot: "b".repeat(40) }),
			).rejects.toThrow(/different handoff/u);
		}));
	it("does not reselect refs on an exact inheritance retry when its unstarted source later adopts", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, api, context, adoptionInput } = await adoptionFixture();
			const before = await contexts.attachDerived("demo", "qa1", { sourceTaskId: "api1", kind: "qa" });
			await api.adopt(USER, "demo", adoptionInput);
			expect(await contexts.attachDerived("demo", "qa1", { sourceTaskId: "api1", kind: "qa" })).toEqual(before);
			expect((await contexts.read("demo", "qa1"))?.inheritance?.sourceContextRevision).toBe(context.revision);
		}));
	it("retains every physical run and losing/uncertain attempt across restarts, without replay or invented historical attribution", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, bundles, index } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			const request: StartTaskSessionRequest = {
				taskId: "api1",
				agentId: "claude",
				binary: "fake",
				args: [],
				cwd: "/owned",
				prompt: "",
				admissionId: "owned-first-admission",
			};
			await expect(
				startWithTaskContext({
					contexts,
					workspaceId: "demo",
					request,
					start: async () => {
						throw new Error("uncertain spawn");
					},
				}),
			).rejects.toThrow("uncertain spawn");
			const reloaded = createTaskContextStore({ bundles, index });
			expect((await reloaded.attempts("demo", "api1"))[0]).toMatchObject({
				kind: "session",
				outcome: "uncertain",
				startedAt: null,
			});
			const start = vi.fn(async () => ({ taskId: "api1", startedAt: 12345 }) as RuntimeTaskSessionSummary);
			await expect(
				startWithTaskContext({ contexts: reloaded, workspaceId: "demo", request, start }),
			).rejects.toThrow(/instead of replaying/u);
			expect(start).not.toHaveBeenCalled();
			await startWithTaskContext({
				contexts: reloaded,
				workspaceId: "demo",
				request: { ...request, admissionId: "explicit-second-run", prompt: "Continue same pinned requirements" },
				start,
			});
			const attempts = await reloaded.attempts("demo", "api1");
			expect(attempts).toHaveLength(2);
			expect(attempts[1]).toMatchObject({ kind: "session", outcome: "started", startedAt: 12345 });
			expect(attempts[0]?.contextRevision).toBe(attempts[1]?.contextRevision);
			expect(start).toHaveBeenCalledWith(
				expect.objectContaining({ prompt: expect.stringContaining(`--attempt-id ${attempts[1]?.id}`) }),
			);
			const api = createTaskContextApi({ contexts: reloaded, bundles });
			const first = await api.read(
				USER,
				"demo",
				taskKnowledgeReadRequestSchema.parse({ taskId: "api1", part: "spec", attemptId: attempts[0]?.id }),
			);
			expect(first.contextRevision).toBe(attempts[0]?.contextRevision);
			await expect(
				api.read(
					USER,
					"demo",
					taskKnowledgeReadRequestSchema.parse({ taskId: "ui1", part: "spec", attemptId: attempts[0]?.id }),
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(await api.attempts(USER, "demo", { taskId: "api1", offset: 0, limit: 1 })).toMatchObject({
				total: 2,
				nextOffset: 1,
				attempts: [expect.objectContaining({ outcome: "started" })],
			});
		}));
	it("records rework context before delivery without calling a queued handoff started or changing acceptance", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, index, record } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			const request = {
				taskId: "api1",
				kind: "rework_handoff" as const,
				requestId: "qa-round-1-at-retained-time",
				snapshot: "a".repeat(40),
				round: 1,
			};
			const first = await contexts.reserveAttempt("demo", request);
			expect(first?.attempt).toMatchObject({
				kind: "rework_handoff",
				outcome: "reserved",
				startedAt: null,
				snapshot: request.snapshot,
			});
			expect(await contexts.reserveAttempt("demo", request)).toEqual(first);
			await expect(contexts.reserveAttempt("demo", { ...request, snapshot: "b".repeat(40) })).rejects.toThrow(
				/different context/u,
			);
			expect((await index.read("demo")).plans.plan1?.approval).toEqual(record.approval);
			if (!first) throw new Error("Missing attempt");
			await expect(contexts.settleAttempt("demo", "api1", first.attempt.id, "started", 123)).rejects.toThrow(
				/No physical/u,
			);
		}));
	it("fails closed when an inherited board anchor loses its retained context, before spawning", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			const derived = await contexts.attachDerived("demo", "qa1", { sourceTaskId: "api1", kind: "qa" });
			if (!derived) throw new Error("Missing handoff");
			const path = join(getProjectKnowledgePaths("demo").root, "task-contexts.json"),
				state = JSON.parse(await readFile(path, "utf8"));
			delete state.tasks.qa1;
			await writeFile(path, JSON.stringify(state));
			const start = vi.fn();
			await expect(
				startWithTaskContext({
					contexts,
					workspaceId: "demo",
					rootRevision: derived.revision,
					request: { taskId: "qa1", agentId: "claude", binary: "fake", args: [], cwd: "/owned", prompt: "" },
					start,
				}),
			).rejects.toThrow(/attachment is missing/u);
			expect(start).not.toHaveBeenCalled();
		}));
	it("keeps native attempt inputs usable from project/shared Markdown without a connector or mutable source dependency", async () =>
		withTemporaryKanbanHome(async ({ homePath }) => {
			const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Obsidian unreachable"));
			try {
				const { contexts, knowledge, bundles, index, input } = await fixture();
				const dir = join(homePath, "shared-markdown");
				await mkdir(dir, { recursive: true });
				const file = join(dir, "shared-contract.md");
				await writeFile(file, "# Shared contract\nUser-curated Markdown baseline.");
				const published = await knowledge.mutate(
					"demo",
					{ kind: "user" },
					{
						action: "publish",
						requestId: randomUUID(),
						expectedRevision: null,
						document: {
							id: "shared-contract",
							title: "Shared contract",
							kind: "contract",
							summary: "",
							tags: [],
							sources: [],
						},
						markdown: await readKnowledgeMarkdown(file),
					},
				);
				if (published.kind !== "document") throw new Error("No shared copy");
				const breakdown = {
					...input.breakdown,
					knowledgeReferences: [{ id: published.document.id, revision: published.document.revision }],
				};
				const prepared = await bundles.prepare("demo", {
					...input,
					breakdown,
					breakdownText: JSON.stringify(breakdown),
				});
				await bundles.persist("demo", prepared);
				await index.update("demo", (current) => {
					const record = current.plans.plan1;
					if (!record?.approval || !record.expansion) throw new Error("No fixture plan");
					return {
						...current,
						plans: {
							plan1: {
								...record,
								approval: {
									...record.approval,
									bundleRevision: prepared.bundle.revision,
									breakdownSha256: prepared.bundle.breakdown.contentHash,
								},
								expansion: {
									...record.expansion,
									bundleRevision: prepared.bundle.revision,
									breakdownSha256: prepared.bundle.breakdown.contentHash,
								},
							},
						},
					};
				});
				await contexts.attachExpansion("demo", "plan1");
				await rm(file);
				const child = await contexts.attachDerived("demo", "qa1", { sourceTaskId: "api1", kind: "qa" });
				expect(child?.documents.some((doc) => doc.id === "shared-contract")).toBe(true);
				const attempt = await contexts.reserveAttempt("demo", {
					taskId: "qa1",
					requestId: "native-offline",
					kind: "session",
				});
				expect(attempt?.context.revision).toBe(child?.revision);
				expect(
					await contexts.reserveAttempt("demo", {
						taskId: "manual1",
						requestId: "legacy-offline",
						kind: "session",
					}),
				).toBeNull();
				expect(
					await contexts.attachDerived("demo", "legacyqa", { sourceTaskId: "manual1", kind: "qa" }),
				).toBeNull();
				expect(
					await contexts.attachDerived("demo", "olderqa", { sourceTaskId: "legacy.card", kind: "qa" }),
				).toBeNull();
				expect(network).not.toHaveBeenCalled();
			} finally {
				network.mockRestore();
			}
		}));
	it("keeps derived/attempt APIs strict own-project and reserves new target ids without adopting old task history", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, bundles, knowledge } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			const api = createTaskContextApi({ contexts, bundles, knowledge, canAttachDerived: async () => true });
			for (const caller of [
				session("other", "orchestrator"),
				{ kind: "unknown", reason: "fixture" } as RuntimeCaller,
			]) {
				await expect(
					api.attachDerived(caller, "demo", { taskId: "qa1", sourceTaskId: "api1", kind: "qa" }),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				await expect(api.attempts(caller, "demo", { taskId: "api1", offset: 0, limit: 10 })).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
			}
			await expect(
				api.attachDerived(session("demo"), "demo", { taskId: "qa1", sourceTaskId: "api1", kind: "qa" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(
				(
					await api.attachDerived(session("demo", "orchestrator"), "demo", {
						taskId: "qa1",
						sourceTaskId: "api1",
						kind: "qa",
					})
				).context?.inheritance?.sourceTaskId,
			).toBe("api1");
			const refused = createTaskContextApi({ contexts, bundles, knowledge, canAttachDerived: async () => false });
			await expect(
				refused.attachDerived(USER, "demo", { taskId: "historical1", sourceTaskId: "api1", kind: "runoff" }),
			).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
			expect(await contexts.read("demo", "historical1")).toBeNull();
		}));
	it("retains attempts without board/index membership and refuses corrupt attempt refs instead of resetting them", async () =>
		withTemporaryKanbanHome(async () => {
			const { contexts, index } = await fixture();
			await contexts.attachExpansion("demo", "plan1");
			const original = await contexts.reserveAttempt("demo", {
				taskId: "api1",
				requestId: "retained-after-pruning",
				kind: "session",
			});
			if (!original) throw new Error("No retained attempt");
			await index.update("demo", (current) => ({ ...current, plans: {} }));
			expect((await contexts.attempts("demo", "api1"))[0]?.id).toBe(original.attempt.id);
			const file = join(getProjectKnowledgePaths("demo").root, "task-contexts.json"),
				state = JSON.parse(await readFile(file, "utf8"));
			state.attempts.api1[0].contextRevision = "f".repeat(64);
			const damaged = JSON.stringify(state);
			await writeFile(file, damaged);
			await expect(contexts.attempts("demo", "api1")).rejects.toThrow(/retained knowledge attempt/u);
			await expect(
				contexts.reserveAttempt("demo", {
					taskId: "api1",
					requestId: "cannot-reset-corrupt-history",
					kind: "session",
				}),
			).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe(damaged);
		}));
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
					return { taskId: "api1", startedAt: 123 } as RuntimeTaskSessionSummary;
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
