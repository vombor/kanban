import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCaller } from "../../../src/isolation/session-identity";
import { hashKnowledgeContent } from "../../../src/knowledge/content-store";
import { createKnowledgeDiscoveryApi } from "../../../src/knowledge/discovery-api";
import { createDiscoveryBroker } from "../../../src/knowledge/discovery-broker";
import { createDiscoveryPolicyStore } from "../../../src/knowledge/discovery-policy";
import { getKnowledgeDiscoveryPaths, getKnowledgeSourcePolicyPath } from "../../../src/state/kanban-home";
import { discoveryPathSchema } from "../../../src/trpc/knowledge-discovery-contract";
import { createTempDir } from "../../utilities/temp-dir";

const roots: ReturnType<typeof createTempDir>[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) root.cleanup();
});
const user: RuntimeCaller = { kind: "user" };
const session = (workspaceId: string, role: "card" | "orchestrator" = "card"): RuntimeCaller => ({
	kind: "session",
	via: "credential",
	session: { workspaceId, role, taskId: "owned", agentId: "claude", cwd: "/owned" },
});
async function setup(vault?: Parameters<typeof createDiscoveryBroker>[0]["vault"]) {
	const root = createTempDir("scoped-discovery-");
	roots.push(root);
	const home = join(root.path, "home"),
		project = join(root.path, "project");
	await mkdir(join(project, "docs"), { recursive: true });
	await writeFile(
		join(project, "README.md"),
		"# Local baseline\nProject Markdown always works. #local\n[Guide](docs/guide.md)",
	);
	await writeFile(join(project, "docs/guide.md"), "# Local guide\nReviewed project guidance.");
	const policy = createDiscoveryPolicyStore(home),
		broker = createDiscoveryBroker({
			homePath: home,
			policy,
			projectPath: (id) => (id === "alpha" ? project : null),
			vault,
		}),
		api = createKnowledgeDiscoveryApi(broker);
	return { root, home, project, policy, broker, api };
}
const query = { query: "", offset: 0, limit: 30 };
describe("scoped Markdown/shared/optional-vault discovery", () => {
	it("retains immutable collection identities and opt-in history across project-data rename", async () => {
		const { home, policy } = await setup();
		const global = await policy.addCollection("alpha", {
			globalRevision: null,
			collection: { id: "team", title: "Team", obsidianFolder: "Shared/Team" },
		});
		const first = await policy.saveProject("alpha", {
			globalRevision: global.globalRevision,
			projectRevision: null,
			shared: ["team"],
			obsidianFolder: "Projects/Alpha",
		});
		await expect(
			policy.addCollection("alpha", {
				globalRevision: global.globalRevision,
				collection: { id: "team", title: "Changed", obsidianFolder: "Other" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			policy.saveProject("beta", {
				globalRevision: global.globalRevision,
				projectRevision: null,
				shared: [],
				obsidianFolder: "Projects/Alpha/Private",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await rename(join(home, "data/alpha"), join(home, "data/renamed"));
		expect(await policy.view("renamed")).toEqual(first);
		const revoked = await policy.saveProject("renamed", {
			...first,
			shared: [],
			obsidianFolder: first.obsidianFolder,
		});
		expect(revoked.shared).toEqual([]);
		const retained = JSON.parse(await readFile(getKnowledgeSourcePolicyPath("renamed", home), "utf8"));
		expect(retained.history).toHaveLength(2);
		expect(retained.history[1]).toMatchObject({ revision: first.projectRevision, shared: ["team"] });
		expect((await policy.scoped("alpha")).collections).toEqual([]);
	});
	it("bounds graph traversal and never follows a Shared root symlink into private files", async () => {
		const { root, home, project, api, policy } = await setup();
		const links: string[] = [];
		for (let n = 0; n < 40; n++) {
			const name = `node-${n}.md`;
			links.push(`[node](${name})`);
			await writeFile(join(project, "docs", name), `# Node ${n}\n#public`);
		}
		await writeFile(join(project, "docs/graph-root.md"), `# Graph root\n${links.join("\n")}`);
		const result = await api.query(user, "alpha", { ...query, query: "Graph root" }),
			source = result.notes[0];
		if (!source) throw new Error("No bounded root");
		const graph = await api.graph(user, "alpha", {
			collection: source.collection,
			path: source.path,
			revision: source.revision,
			depth: 2,
		});
		expect(graph.nodes).toHaveLength(30);
		expect(graph.truncated).toBe(true);
		expect(graph.edges.length).toBeLessThanOrEqual(120);
		await mkdir(join(root.path, "outside"));
		await writeFile(join(root.path, "outside/private.md"), "# NEVER SHARED");
		const definition = await policy.addCollection("alpha", {
			globalRevision: null,
			collection: { id: "team", title: "Team", obsidianFolder: null },
		});
		await policy.saveProject("alpha", {
			globalRevision: definition.globalRevision,
			projectRevision: null,
			shared: ["team"],
			obsidianFolder: null,
		});
		await mkdir(getKnowledgeDiscoveryPaths(home).shared, { recursive: true });
		await symlink(join(root.path, "outside"), join(getKnowledgeDiscoveryPaths(home).shared, "team"));
		expect((await api.query(user, "alpha", { ...query, query: "NEVER SHARED" })).notes).toEqual([]);
	});
	it("works from project Markdown without any connector or external request", async () => {
		const vault = vi.fn(async () => {
			throw new Error("no optional service");
		});
		const { api } = await setup(vault);
		const result = await api.query(session("alpha"), "alpha", query);
		expect(result.notes.map((note) => note.path)).toEqual(expect.arrayContaining(["README.md", "docs/guide.md"]));
		expect(result.notes).toHaveLength(2);
		expect(vault).not.toHaveBeenCalled();
		const start = result.notes.find((note) => note.path === "README.md");
		if (!start) throw new Error("No source");
		expect((await api.graph(session("alpha"), "alpha", { ...start, depth: 1 })).edges).toHaveLength(1);
	});
	it("requires explicit user-only collection/project opt-ins and protects stale writes and private folder boundaries", async () => {
		const { home, policy, api } = await setup();
		const initial = await policy.view("alpha");
		const defined = await api.saveCollection(user, "alpha", {
			globalRevision: initial.globalRevision,
			collection: { id: "team", title: "Shared team", obsidianFolder: "Shared" },
		});
		const folder = join(getKnowledgeDiscoveryPaths(home).shared, "team");
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, "guide.md"), "# Shared guide\nReusable reference. #shared");
		expect(
			(await api.query(session("alpha"), "alpha", query)).notes.some((note) => note.collection === "shared:team"),
		).toBe(false);
		const opted = await api.savePolicy(user, "alpha", {
			globalRevision: defined.globalRevision,
			projectRevision: null,
			shared: ["team"],
			obsidianFolder: null,
		});
		expect(
			(await api.query(session("alpha"), "alpha", query)).notes.some((note) => note.collection === "shared:team"),
		).toBe(true);
		await expect(
			api.savePolicy(user, "alpha", {
				globalRevision: defined.globalRevision,
				projectRevision: null,
				shared: [],
				obsidianFolder: null,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			api.savePolicy(user, "alpha", {
				globalRevision: defined.globalRevision,
				projectRevision: opted.projectRevision,
				shared: [],
				obsidianFolder: "shared/private",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		for (const caller of [
			session("alpha"),
			session("alpha", "orchestrator"),
			session("other"),
			{ kind: "unknown", reason: "fixture" } as RuntimeCaller,
		])
			await expect(api.policy(caller, "alpha")).rejects.toMatchObject({ code: "FORBIDDEN" });
		for (const caller of [session("other"), { kind: "unknown", reason: "fixture" } as RuntimeCaller])
			await expect(api.query(caller, "alpha", query)).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("refuses symlinks, path escapes, stale source bytes and terminal control payloads without mutable substitution", async () => {
		const { root, project, api } = await setup();
		await writeFile(join(root.path, "private.md"), "# PRIVATE OUTSIDE");
		await symlink(join(root.path, "private.md"), join(project, "docs/linked.md"));
		const result = await api.query(user, "alpha", query);
		expect(result.notes.some((note) => note.path.includes("linked"))).toBe(false);
		const note = result.notes[0];
		if (!note) throw new Error("No source");
		await writeFile(join(project, note.path), "# Changed source");
		await expect(
			api.read(user, "alpha", {
				collection: note.collection,
				path: note.path,
				revision: note.revision,
				offset: 0,
				limit: 4096,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		for (const path of [
			"../private.md",
			"/etc/private.md",
			"docs/%2e%2e/private.md",
			"docs\\private.md",
			"notes/file:stream.md",
			"docs/a /x.md",
			"notes/\u001b.md",
		])
			expect(discoveryPathSchema.safeParse(path).success).toBe(false);
		await writeFile(join(project, "docs/control.md"), "# Unsafe\n\u001b]52;clipboard;bad\u0007");
		expect((await api.query(user, "alpha", query)).notes.some((item) => item.path === "docs/control.md")).toBe(false);
	});
	it("filters native vault links/backlinks/tags at both endpoints and preserves Markdown fallback on outage", async () => {
		const calls: string[] = [];
		const notes: Record<string, { content: string; links: string[]; backlinks: string[]; tags: string[] }> = {
			"Own/a.md": {
				content: "# Own note",
				links: ["Own/b.md", "Shared/team.md", "Other/private.md"],
				backlinks: ["Other/private.md"],
				tags: ["own"],
			},
			"Own/b.md": { content: "# Own linked note", links: [], backlinks: ["Own/a.md"], tags: ["own"] },
			"Shared/team.md": {
				content: "# Shared native note",
				links: [],
				backlinks: ["Own/a.md", "Other/private.md"],
				tags: ["shared"],
			},
		};
		let offline = false;
		const vault = async () => {
			if (offline) throw new Error("secret-bearing upstream failure");
			return {
				list: async (folder: string) => {
					calls.push(folder);
					return folder === "Own" ? ["a.md", "b.md", "../Other/"] : folder === "Shared" ? ["team.md"] : [];
				},
				read: async (path: string) => {
					calls.push(path);
					const note = notes[path];
					if (!note) throw new Error("forbidden/missing fixture path");
					return { path, ...note };
				},
				close: async () => {},
			};
		};
		const { api, policy } = await setup(vault);
		const g = await policy.addCollection("alpha", {
			globalRevision: null,
			collection: { id: "team", title: "Team", obsidianFolder: "Shared" },
		});
		await policy.saveProject("alpha", {
			globalRevision: g.globalRevision,
			projectRevision: null,
			shared: ["team"],
			obsidianFolder: "Own",
		});
		const result = await api.query(session("alpha"), "alpha", query),
			start = result.notes.find((note) => note.collection === "obsidian:project" && note.path === "a.md");
		if (!start) throw new Error("No permitted source");
		const graph = await api.graph(session("alpha"), "alpha", { ...start, depth: 2 });
		expect(graph.nodes.filter((node) => node.collection.startsWith("obsidian:")).length).toBe(3);
		expect(JSON.stringify(graph)).not.toContain("Other");
		expect(calls.some((path) => path.includes("Other"))).toBe(false);
		expect(graph.tags).toContainEqual({ tag: "own", count: 2 });
		offline = true;
		const fallback = await api.query(user, "alpha", query);
		expect(fallback.notes.some((note) => note.collection === "project")).toBe(true);
		expect(fallback.warnings).toContain("obsidian_unavailable_markdown_fallback");
		expect(JSON.stringify(fallback)).not.toContain("secret-bearing");
	});
	it("fences a revoked Shared grant while a source read is in flight", async () => {
		let entered!: () => void, release!: () => void;
		const reached = new Promise<void>((resolve) => {
				entered = resolve;
			}),
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
		const { api, policy } = await setup(async () => ({
			list: async () => ["note.md"],
			read: async (path) => {
				entered();
				await gate;
				return { path, content: "# Shared response", links: [], backlinks: [], tags: [] };
			},
			close: async () => {},
		}));
		const g = await policy.addCollection("alpha", {
			globalRevision: null,
			collection: { id: "team", title: "Team", obsidianFolder: "Shared" },
		});
		const p = await policy.saveProject("alpha", {
			globalRevision: g.globalRevision,
			projectRevision: null,
			shared: ["team"],
			obsidianFolder: null,
		});
		const reading = api.read(user, "alpha", {
			collection: "obsidian:shared:team",
			path: "note.md",
			revision: hashKnowledgeContent("# Shared response"),
			offset: 0,
			limit: 4096,
		});
		await reached;
		await policy.saveProject("alpha", {
			globalRevision: g.globalRevision,
			projectRevision: p.projectRevision,
			shared: [],
			obsidianFolder: null,
		});
		release();
		await expect(reading).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("keeps local project Markdown when policy is damaged, never overwrites it or exposes retained grants", async () => {
		const { home, api, policy } = await setup();
		const path = getKnowledgeSourcePolicyPath("alpha", home);
		await mkdir(join(home, "data/alpha/knowledge"), { recursive: true });
		await writeFile(path, "damaged policy");
		const result = await api.query(user, "alpha", query);
		expect(result.notes.some((note) => note.collection === "project")).toBe(true);
		expect(result.warnings).toContain("sharing_configuration_unavailable");
		await expect(
			policy.saveProject("alpha", { globalRevision: null, projectRevision: null, shared: [], obsidianFolder: null }),
		).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe("damaged policy");
	});
});
