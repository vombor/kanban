import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { createKnowledgeApi } from "../../../src/knowledge/knowledge-api";
import { createProjectKnowledgeStore } from "../../../src/knowledge/knowledge-store";
import { describeKnowledgeMarkdown } from "../../../src/knowledge/markdown";
import { getProjectKnowledgePaths } from "../../../src/state/kanban-home";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import {
	type KnowledgeActor,
	type KnowledgeMetadata,
	type KnowledgeMutation,
	knowledgeHistoryRequestSchema,
	knowledgeListRequestSchema,
	knowledgeMutationSchema,
	knowledgeProposalsRequestSchema,
	knowledgeReadRequestSchema,
	knowledgeSearchRequestSchema,
} from "../../../src/trpc/knowledge-contract";
import { createTempDir } from "../../utilities/temp-dir";

const roots: ReturnType<typeof createTempDir>[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) root.cleanup();
});
const user: KnowledgeActor = { kind: "user" };
const orchestrator: KnowledgeActor = { kind: "session", role: "orchestrator", taskId: "__home_agent__:alpha:claude" };
const card: KnowledgeActor = { kind: "session", role: "card", taskId: "abcde" };
const metadata = (id = "api-contract"): KnowledgeMetadata => ({
	id,
	kind: "contract",
	title: "API Contract",
	summary: "Pagination interface",
	tags: ["api"],
	sources: [],
});
const mutation = (
	id = "api-contract",
	markdown = "# API Contract\n\n## Response shape\nUse cursor pagination.\n\n## Errors\nUse 409 for a conflict.\n",
	expectedRevision: string | null = null,
): KnowledgeMutation => ({
	action: "publish",
	requestId: randomUUID(),
	document: metadata(id),
	markdown,
	expectedRevision,
});
function setup(beforeCommit?: () => Promise<void>) {
	const root = createTempDir("kanban-knowledge-");
	roots.push(root);
	const store = createProjectKnowledgeStore({
		homePath: root.path,
		now: () => new Date("2026-10-15T12:00:00Z"),
		beforeCommit,
	});
	return {
		home: root.path,
		store,
		api: createKnowledgeApi(store),
		paths: getProjectKnowledgePaths("alpha", root.path),
	};
}
describe("knowledge UI permission readout", () => {
	it("returns strict own-project curation capabilities without relaxing mutation authority", async () => {
		const { api } = setup();
		const session = (workspaceId: string, role: "card" | "orchestrator"): RuntimeCaller => ({
			kind: "session",
			via: "credential",
			session: { workspaceId, role, taskId: "fixture", agentId: "claude", cwd: "/owned" },
		});
		expect(await api.permissions({ kind: "user" }, "alpha")).toEqual({
			canPropose: true,
			canPublish: true,
			canPin: true,
		});
		expect(await api.permissions(session("alpha", "orchestrator"), "alpha")).toEqual({
			canPropose: true,
			canPublish: true,
			canPin: false,
		});
		expect(await api.permissions(session("alpha", "card"), "alpha")).toEqual({
			canPropose: true,
			canPublish: false,
			canPin: false,
		});
		for (const caller of [session("other", "orchestrator"), { kind: "unknown", reason: "fixture" } as RuntimeCaller])
			await expect(api.permissions(caller, "alpha")).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
async function publishedRevision(
	store: ReturnType<typeof createProjectKnowledgeStore>,
	input = mutation(),
	actor = user,
) {
	const result = await store.mutate("alpha", actor, input);
	if (result.kind !== "document") throw new Error("Expected published document");
	return result.document.revision;
}
const caller = (workspaceId = "alpha", role: "card" | "orchestrator" = "card"): RuntimeCaller => ({
	kind: "session",
	via: "credential",
	session: { workspaceId, taskId: "abcde", role, agentId: "claude", cwd: `/projects/${workspaceId}` },
});

describe("versioned project knowledge store", () => {
	it("does not bootstrap files on reads and publishes private immutable objects with provenance", async () => {
		const { store, paths } = setup();
		expect(await store.snapshot("alpha")).toMatchObject({ version: 1, documents: {}, proposals: {}, receipts: {} });
		await expect(stat(paths.root)).rejects.toMatchObject({ code: "ENOENT" });
		const result = await store.mutate("alpha", user, mutation());
		expect(result.kind).toBe("document");
		if (result.kind !== "document") throw new Error("Expected document");
		const state = await store.snapshot("alpha");
		expect(state.documents["api-contract"]?.[0]).toMatchObject({
			publishedBy: user,
			parentRevision: null,
			action: "publish",
		});
		expect(await store.readContent("alpha", result.document.contentHash)).toContain("cursor pagination");
		expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
		expect((await stat(paths.manifest)).mode & 0o777).toBe(0o600);
		expect((await stat(join(paths.objects, `${result.document.contentHash}.md`))).mode & 0o777).toBe(0o600);
	});
	it("serializes concurrent edits so a stale editor cannot replace the winning revision", async () => {
		const { store, home } = setup();
		const original = await publishedRevision(store);
		const other = createProjectKnowledgeStore({ homePath: home });
		const results = await Promise.allSettled([
			store.mutate("alpha", user, mutation("api-contract", "first edit", original)),
			other.mutate("alpha", user, mutation("api-contract", "second edit", original)),
		]);
		expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
		expect((await store.snapshot("alpha")).documents["api-contract"]).toHaveLength(2);
	});
	it("replays exact retries, refuses request-id reuse and preserves historical bodies", async () => {
		const { store, api } = setup();
		const input = mutation();
		const first = await store.mutate("alpha", user, input);
		expect(await store.mutate("alpha", user, input)).toEqual(first);
		if (first.kind !== "document") throw new Error("Expected document");
		await publishedRevision(store, mutation("api-contract", "updated contract", first.document.revision));
		expect(await store.mutate("alpha", user, input)).toEqual(first);
		await expect(
			store.mutate("alpha", user, { ...input, markdown: "different content" } as KnowledgeMutation),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const old = await api.read(
			{ kind: "user" },
			"alpha",
			knowledgeReadRequestSchema.parse({ id: "api-contract", revision: first.document.revision }),
		);
		expect(old.markdown).toContain("cursor pagination");
		expect(old.authority).toBe("reference_material_not_execution_approval");
	});
	it("does not change the committed manifest on a failed commit, and can retry an orphaned valid object", async () => {
		const fail = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const { store, paths } = setup(fail);
		const original = await publishedRevision(store);
		const before = await readFile(paths.manifest, "utf8");
		const input = mutation("api-contract", "valid but initially uncommitted content", original);
		fail.mockRejectedValueOnce(new Error("simulated crash before manifest commit"));
		await expect(store.mutate("alpha", user, input)).rejects.toThrow("simulated crash");
		expect(await readFile(paths.manifest, "utf8")).toBe(before);
		await expect(store.mutate("alpha", user, input)).resolves.toMatchObject({ kind: "document" });
	});
	it("refuses damaged manifests, changed revision metadata, missing bodies and symlinked objects", async () => {
		const { store, paths, home } = setup();
		const result = await store.mutate("alpha", user, mutation());
		if (result.kind !== "document") throw new Error("Expected document");
		const original = await readFile(paths.manifest, "utf8");
		await writeFile(paths.manifest, "truncated");
		await expect(store.mutate("alpha", user, mutation("another-doc"))).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
		expect(await readFile(paths.manifest, "utf8")).toBe("truncated");
		await writeFile(paths.manifest, original);
		const changed = JSON.parse(original) as { documents: Record<string, Array<{ document: { title: string } }>> };
		const revision = changed.documents["api-contract"]?.[0];
		if (!revision) throw new Error("Missing revision");
		revision.document.title = "tampered metadata";
		await writeFile(paths.manifest, JSON.stringify(changed));
		await expect(store.snapshot("alpha")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
		await writeFile(paths.manifest, original);
		const object = join(paths.objects, `${result.document.contentHash}.md`);
		await writeFile(object, "changed bytes");
		await expect(store.readContent("alpha", result.document.contentHash)).rejects.toThrow("integrity");
		await expect(store.mutate("alpha", user, mutation("another-doc"))).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
		await rename(object, join(home, "damaged-copy.md"));
		const outside = join(home, "outside.md");
		await writeFile(outside, "private outside content");
		await symlink(outside, object);
		await expect(store.readContent("alpha", result.document.contentHash)).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
	});
	it("rejects path escapes, reserved ids and terminal-control content before publication", async () => {
		const { store } = setup();
		for (const workspace of ["../escape", "", ".", "..", "nested/project", "models", "prices"])
			await expect(store.snapshot(workspace)).rejects.toThrow();
		for (const id of ["../secret", "constructor", "prototype", "__proto__"])
			expect(knowledgeMutationSchema.safeParse(mutation(id)).success).toBe(false);
		expect(knowledgeMutationSchema.safeParse(mutation("valid", "\u001b]52;clipboard\u0007")).success).toBe(false);
		expect(knowledgeMutationSchema.safeParse({ ...mutation(), alias: "user-pinned" }).success).toBe(false);
	});
	it("remains readable when a workspace data tree is renamed or the Kanban home is copied", async () => {
		const { store, home } = setup();
		const revision = await publishedRevision(store);
		await rename(join(home, "data", "alpha"), join(home, "data", "renamed"));
		expect((await store.snapshot("renamed")).documents["api-contract"]?.[0]?.revision).toBe(revision);
		const moved = createTempDir("kanban-knowledge-moved-");
		roots.push(moved);
		await mkdir(join(moved.path, "data"), { recursive: true });
		await rename(join(home, "data", "renamed"), join(moved.path, "data", "renamed"));
		const migrated = createProjectKnowledgeStore({ homePath: moved.path });
		const view = await createKnowledgeApi(migrated).read(
			{ kind: "user" },
			"renamed",
			knowledgeReadRequestSchema.parse({ id: "api-contract" }),
		);
		expect(view.document.revision).toBe(revision);
		expect(view.markdown).toContain("cursor pagination");
	});
});

describe("curated proposals and pins", () => {
	it("lets a card propose but only a curator publish, with original proposal provenance retained", async () => {
		const { store } = setup();
		await expect(store.mutate("alpha", card, mutation())).rejects.toMatchObject({ code: "FORBIDDEN" });
		const input = mutation();
		if (input.action !== "publish") throw new Error("Expected publish input");
		const proposed = await store.mutate("alpha", card, {
			...input,
			action: "propose",
			reason: "Agree on the pagination contract",
		});
		if (proposed.kind !== "proposal") throw new Error("Expected proposal");
		expect((await store.snapshot("alpha")).documents).toEqual({});
		const review: KnowledgeMutation = {
			action: "review",
			requestId: randomUUID(),
			proposalId: proposed.proposal.id,
			decision: "publish",
			expectedRevision: null,
		};
		await expect(store.mutate("alpha", card, review)).rejects.toMatchObject({ code: "FORBIDDEN" });
		const published = await store.mutate("alpha", orchestrator, review);
		expect(published).toMatchObject({
			kind: "proposal",
			proposal: { status: "published", submittedBy: card, reviewedBy: orchestrator },
		});
		expect((await store.snapshot("alpha")).documents["api-contract"]).toHaveLength(1);
	});
	it("does not silently rebase a stale proposal and allows explicit rejection", async () => {
		const { store } = setup();
		const base = await publishedRevision(store);
		const input = mutation("api-contract", "proposed text", base);
		if (input.action !== "publish") throw new Error("Expected publish input");
		await store.mutate("alpha", card, { ...input, action: "propose", reason: "proposal" });
		const current = await publishedRevision(store, mutation("api-contract", "new published text", base));
		for (const expectedRevision of [base, current])
			await expect(
				store.mutate("alpha", orchestrator, {
					action: "review",
					requestId: randomUUID(),
					proposalId: input.requestId,
					decision: "publish",
					expectedRevision,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			store.mutate("alpha", orchestrator, {
				action: "review",
				requestId: randomUUID(),
				proposalId: input.requestId,
				decision: "reject",
				expectedRevision: current,
			}),
		).resolves.toMatchObject({ kind: "proposal", proposal: { status: "rejected" } });
	});
	it("protects user pins against publication, metadata replacement, restoration and orchestrator review", async () => {
		const { store } = setup();
		const original = await publishedRevision(store);
		const pinInput: KnowledgeMutation = {
			action: "pin",
			requestId: randomUUID(),
			id: "api-contract",
			pinned: true,
			expectedRevision: original,
		};
		await expect(store.mutate("alpha", orchestrator, pinInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
		const pinned = await store.mutate("alpha", user, pinInput);
		if (pinned.kind !== "document") throw new Error("Expected pinned document");
		for (const content of ["a new contract", "restored old contract"])
			await expect(
				store.mutate("alpha", orchestrator, mutation("api-contract", content, pinned.document.revision)),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		const change = mutation("api-contract", "new decision", pinned.document.revision);
		if (change.action !== "publish") throw new Error("Expected change");
		await store.mutate("alpha", card, { ...change, action: "propose", reason: "user review needed" });
		const review: KnowledgeMutation = {
			action: "review",
			requestId: randomUUID(),
			proposalId: change.requestId,
			decision: "publish",
			expectedRevision: pinned.document.revision,
		};
		await expect(store.mutate("alpha", orchestrator, review)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await store.mutate("alpha", user, review);
		const current = (await store.snapshot("alpha")).documents["api-contract"]?.at(-1);
		expect(current?.pinnedByUser).toBe(true);
		if (!current) throw new Error("Missing current revision");
		const unpin: KnowledgeMutation = {
			action: "pin",
			requestId: randomUUID(),
			id: "api-contract",
			pinned: false,
			expectedRevision: current.revision,
		};
		await expect(store.mutate("alpha", orchestrator, unpin)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await store.mutate("alpha", user, unpin);
		expect((await store.snapshot("alpha")).documents["api-contract"]?.at(-1)?.pinnedByUser).toBe(false);
	});
});

describe("bounded reads and strict knowledge identity", () => {
	it("uses Markdown AST sections, avoids fenced-code headings, and bounds reads/search/context", async () => {
		const { store, api } = setup();
		const markdown = [
			"# Contract\n\n```md\n# Not a heading\n```\n\n## Response shape\n",
			"cursor pagination ".repeat(300),
			"\n## Errors\nConflict.\n",
		].join("");
		await publishedRevision(store, mutation("api-contract", markdown));
		const read = await api.read(
			caller(),
			"alpha",
			knowledgeReadRequestSchema.parse({ id: "api-contract", section: "response-shape", limit: 100 }),
		);
		expect(read.sections.map((section) => section.id)).toEqual(["contract", "response-shape", "errors"]);
		expect(read.markdown).toHaveLength(100);
		expect(read.truncated).toBe(true);
		expect(read.nextOffset).toBe(100);
		expect(read.markdown).not.toContain("Conflict.");
		const search = await api.search(
			caller(),
			"alpha",
			knowledgeSearchRequestSchema.parse({ query: "pagination", limit: 1 }),
		);
		expect(search.results).toHaveLength(1);
		expect(search.results[0]?.snippet.length).toBeLessThanOrEqual(320);
		const context = await api.context(caller(), "alpha");
		expect(context.authority).toBe("project_index_not_task_approval");
		expect(JSON.stringify(context)).not.toContain("cursor pagination cursor pagination");
		await expect(
			api.read(caller(), "alpha", knowledgeReadRequestSchema.parse({ id: "api-contract", section: "unknown" })),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("accepts the user and own roles but refuses unknown/foreign callers for every query and mutation", async () => {
		const { store, api } = setup();
		await publishedRevision(store);
		for (const own of [{ kind: "user" } as const, caller(), caller("alpha", "orchestrator")]) {
			expect((await api.list(own, "alpha", knowledgeListRequestSchema.parse(undefined))).documents).toHaveLength(1);
		}
		for (const foreign of [
			caller("beta"),
			caller("beta", "orchestrator"),
			{ kind: "unknown", reason: "not identified" } as const,
		]) {
			await expect(api.list(foreign, "alpha", knowledgeListRequestSchema.parse(undefined))).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(
				api.read(foreign, "alpha", knowledgeReadRequestSchema.parse({ id: "api-contract" })),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				api.search(foreign, "alpha", knowledgeSearchRequestSchema.parse({ query: "cursor" })),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(api.context(foreign, "alpha")).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				api.proposals(foreign, "alpha", knowledgeProposalsRequestSchema.parse(undefined)),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				api.proposalRead(foreign, "alpha", { id: randomUUID(), offset: 0, limit: 100 }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				api.history(foreign, "alpha", knowledgeHistoryRequestSchema.parse({ id: "api-contract" })),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(api.mutate(foreign, "alpha", mutation("another-doc"))).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
	});
	it("resolves strict identity on scoped RPCs even if isolation is off and ordinary identity looks like user", async () => {
		const { store, api } = setup();
		await publishedRevision(store);
		const client = runtimeAppRouter.createCaller({
			requestedWorkspaceId: "alpha",
			workspaceScope: { workspaceId: "alpha", workspacePath: "/projects/alpha" },
			getCaller: async () => ({ kind: "user" }),
			resolveStrictCaller: async () => caller("beta"),
			knowledgeApi: api,
		} as unknown as RuntimeTrpcContext);
		await expect(client.knowledge.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(client.knowledge.context()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(client.knowledge.mutate(mutation("another-doc"))).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("handles Unicode/repeated headings with stable unique ids and bounded continuations", () => {
		const result = describeKnowledgeMarkdown("# API\n😀\n# API\nother\n");
		expect(result.sections.map((section) => section.id)).toEqual(["api", "api-1"]);
	});
});
