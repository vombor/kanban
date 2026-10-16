import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createObsidianConnectorApi } from "../../../src/knowledge/obsidian/connector-api";
import { probeObsidianConnector } from "../../../src/knowledge/obsidian/connector-probe";
import { createObsidianConnectorStore } from "../../../src/knowledge/obsidian/connector-store";
import { parsePlanBreakdown } from "../../../src/plans/plan-breakdown";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { obsidianConnectorWriteSchema } from "../../../src/trpc/obsidian-connector-contract";
import { createTempDir } from "../../utilities/temp-dir";

const roots: ReturnType<typeof createTempDir>[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const root of roots.splice(0)) root.cleanup();
});
function setup() {
	const root = createTempDir("kanban-obsidian-");
	roots.push(root);
	const path = join(root.path, "secrets", "obsidian-connector.json");
	return { path, store: createObsidianConnectorStore(path) };
}
const settings = { enabled: true, baseUrl: "http://obsidian.example:27123", caCertificate: "" };
const key = "test-private-sentinel";
const session = {
	kind: "session",
	via: "credential",
	session: { workspaceId: "alpha", taskId: "abcde", role: "card", agentId: "claude", cwd: "/projects/alpha" },
} as const;

describe("system Obsidian connector", () => {
	it("starts disabled without files, saves privately, never returns its key and preserves it across edits", async () => {
		const { path, store } = setup();
		const api = createObsidianConnectorApi({ store });
		const initial = await api.get({ kind: "user" });
		expect(initial).toMatchObject({
			apiKeyConfigured: false,
			revision: null,
			settings: { enabled: false, baseUrl: "" },
		});
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
		const saved = await api.save({ kind: "user" }, { settings, expectedRevision: null, apiKey: key });
		expect(JSON.stringify(saved)).not.toContain(key);
		expect(saved.apiKeyConfigured).toBe(true);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
		const changed = await api.save(
			{ kind: "user" },
			{ settings: { ...settings, baseUrl: "http://new.example" }, expectedRevision: saved.revision },
		);
		expect(changed.apiKeyConfigured).toBe(true);
		expect((await store.read()).apiKey).toBe(key);
		await expect(api.save({ kind: "user" }, { settings, expectedRevision: saved.revision })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		const removed = await api.save(
			{ kind: "user" },
			{ settings: { ...settings, enabled: false }, expectedRevision: changed.revision, apiKey: null },
		);
		expect(removed.apiKeyConfigured).toBe(false);
	});
	it("refuses malformed endpoints, newline keys, enabled-without-key settings and corrupt data", async () => {
		for (const baseUrl of [
			"file:///etc/passwd",
			"https://user:password@example.test",
			"https://example.test/?token=private",
			"http://example.test/#fragment",
		]) {
			expect(
				obsidianConnectorWriteSchema.safeParse({
					settings: { ...settings, baseUrl },
					apiKey: key,
					expectedRevision: null,
				}).success,
			).toBe(false);
		}
		expect(
			obsidianConnectorWriteSchema.safeParse({ settings, expectedRevision: null, apiKey: "bad\nkey" }).success,
		).toBe(false);
		const { path, store } = setup();
		await expect(store.save({ settings, expectedRevision: null })).rejects.toThrow("needs an API key");
		await expect(
			store.save({
				settings: { ...settings, caCertificate: "not-a-certificate" },
				expectedRevision: null,
				apiKey: key,
			}),
		).rejects.toThrow();
		await store.save({ settings, apiKey: key, expectedRevision: null });
		await writeFile(path, "broken-json");
		await expect(store.save({ settings, apiKey: "replacement", expectedRevision: null })).rejects.toThrow(
			"existing file was not changed",
		);
		expect(await readFile(path, "utf8")).toBe("broken-json");
	});
	it("uses strict user-only identity for every RPC, even if the ordinary identity says user", async () => {
		const { store } = setup();
		const probe = vi.fn();
		const api = createObsidianConnectorApi({ store, probe });
		for (const caller of [
			session,
			{ ...session, session: { ...session.session, role: "orchestrator" as const } },
			{ kind: "unknown", reason: "not identified" } as const,
		]) {
			const client = runtimeAppRouter.createCaller({
				requestedWorkspaceId: null,
				workspaceScope: null,
				getCaller: async () => ({ kind: "user" }),
				resolveStrictCaller: async () => caller,
				obsidianConnectorApi: api,
			} as unknown as RuntimeTrpcContext);
			await expect(client.obsidianConnector.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				client.obsidianConnector.save({ settings, apiKey: key, expectedRevision: null }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				client.obsidianConnector.test({ settings, apiKey: key, expectedRevision: null }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(probe).not.toHaveBeenCalled();
	});
	it("tests a credential draft without saving and does not relay a consumer's secret-bearing exception", async () => {
		const { store } = setup();
		const probe = vi.fn(async () => {
			throw new Error(key);
		});
		const api = createObsidianConnectorApi({ store, probe });
		await expect(api.test({ kind: "user" }, { settings, apiKey: key, expectedRevision: null })).rejects.not.toThrow(
			key,
		);
		expect((await store.read()).apiKey).toBeNull();
	});
});

async function fakeApi(mode: "good" | "wrong_key" | "redirect" | "large" | "reflect_key" | "no_index_state") {
	const requests: Array<{ path: string; authorization: string | undefined }> = [];
	const server = createServer((request, response) => {
		requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
		if (mode === "redirect") {
			response.writeHead(302, { Location: "/elsewhere" });
			response.end();
			return;
		}
		response.setHeader("Content-Type", "application/json");
		if (mode === "large") {
			response.end(JSON.stringify({ content: "x".repeat(3 * 1024 * 1024) }));
			return;
		}
		if (request.url === "/")
			response.end(
				JSON.stringify({
					authenticated: mode !== "wrong_key",
					versions: { self: mode === "reflect_key" ? key : "5.4.0" },
					state: mode === "no_index_state" ? {} : { metadataCache: { lastActivityAt: new Date().toISOString() } },
				}),
			);
		else
			response.end(
				JSON.stringify({
					paths: {
						"/search/": {},
						"/vault/{filename}": {
							get: { responses: { "200": { content: { "application/vnd.olrapi.document-map+json": {} } } } },
						},
					},
					components: { schemas: { NoteJson: { properties: { links: {}, backlinks: {}, unresolvedLinks: {} } } } },
				}),
			);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fake API address");
	return {
		requests,
		record: {
			version: 1 as const,
			revision: null,
			apiKey: key,
			settings: { ...settings, baseUrl: `http://127.0.0.1:${address.port}` },
		},
	};
}
describe("Obsidian REST capability test", () => {
	it("reports unknown indexing rather than refusing a server with no indexing observations", async () => {
		const fake = await fakeApi("no_index_state");
		const result = await probeObsidianConnector(fake.record);
		expect(result).toMatchObject({ ok: true, indexing: "unknown", capabilities: { graph: true } });
	});
	it("does not return credentials reflected in upstream version metadata", async () => {
		const fake = await fakeApi("reflect_key");
		const result = await probeObsidianConnector(fake.record);
		expect(result.ok).toBe(true);
		expect(result.version).toBeNull();
		expect(JSON.stringify(result)).not.toContain(key);
	});
	it("checks authenticated native graph/search/document maps without reading any vault note", async () => {
		const fake = await fakeApi("good");
		const result = await probeObsidianConnector(fake.record);
		expect(result).toMatchObject({
			ok: true,
			version: "5.4.0",
			indexing: "recent_activity",
			capabilities: { graph: true, search: true, documentMap: true },
		});
		expect(fake.requests.map((request) => request.path)).toEqual(["/", "/openapi.json"]);
		expect(fake.requests.every((request) => request.authorization === `Bearer ${key}`)).toBe(true);
		expect(JSON.stringify(result)).not.toContain(key);
	});
	it.each(["wrong_key", "redirect", "large"] as const)("fails safely on %s", async (mode) => {
		const fake = await fakeApi(mode);
		const result = await probeObsidianConnector(fake.record);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(key);
		expect(fake.requests).toHaveLength(1);
	});
});

it("validates the efficiency roadmap against the real plan graph schema", async () => {
	const text = await readFile(
		join(process.cwd(), "docs/specs/cost-aware-multi-agent-coordination.cards.json"),
		"utf8",
	);
	const result = parsePlanBreakdown(text, "cost-aware-multi-agent-coordination");
	expect(result.ok, result.ok ? "" : result.issues.join("\n")).toBe(true);
});
