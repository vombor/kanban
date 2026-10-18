import { posix } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { visit } from "unist-util-visit";
import { getKanbanHomePath } from "../state/kanban-home";
import { type DiscoveryNote, type DiscoveryPointer, discoveryPathSchema } from "../trpc/knowledge-discovery-contract";
import { hashKnowledgeContent } from "./content-store";
import { listSourceMarkdown, readSourceMarkdown, safeSourcePath } from "./discovery-files";
import { createDiscoveryPolicyStore, type DiscoveryPolicyStore } from "./discovery-policy";
import { KnowledgeError } from "./knowledge-error";
import { describeKnowledgeMarkdown, sliceKnowledgeText } from "./markdown";
import { createObsidianConnectorStore } from "./obsidian/connector-store";
import { createScopedObsidianReader, type ScopedObsidianReader } from "./obsidian/scoped-reader";

interface Source {
	id: string;
	root: string;
	vault: boolean;
	project: boolean;
	/** Shared reads remain anchored to the trusted home even if their directory is swapped after inventory. */
	sharedPath?: string;
}
interface Loaded {
	note: DiscoveryNote;
	content: string;
	links: string[];
	backlinks: string[];
	source: Source;
}
const key = (pointer: Pick<DiscoveryPointer, "collection" | "path">) =>
	JSON.stringify([pointer.collection, pointer.path]);
function markdownFacts(content: string, path: string) {
	const root = fromMarkdown(content),
		links: string[] = [],
		tags = new Set<string>();
	visit(root, "link", (node) => {
		try {
			if (/^[a-z][a-z0-9+.-]*:/iu.test(node.url) || node.url.startsWith("/")) return;
			const target = posix.normalize(
				posix.join(posix.dirname(path), decodeURIComponent(node.url.split(/[?#]/u)[0] ?? "")),
			);
			if (discoveryPathSchema.safeParse(target).success && target.toLowerCase().endsWith(".md")) links.push(target);
		} catch {
			/* Invalid links grant no path access. */
		}
	});
	visit(root, "text", (node) => {
		for (const match of node.value.matchAll(/(?:^|\s)#([a-zA-Z][\w/-]{0,79})/gu)) if (match[1]) tags.add(match[1]);
	});
	return { links, tags: [...tags].slice(0, 40) };
}
export function createDiscoveryBroker(options: {
	homePath?: string;
	policy?: DiscoveryPolicyStore;
	projectPath: (workspaceId: string) => string | null;
	vault?: () => Promise<ScopedObsidianReader>;
}) {
	const home = options.homePath ?? getKanbanHomePath(),
		policy = options.policy ?? createDiscoveryPolicyStore(home);
	const sources = async (workspaceId: string) => {
		const config = await policy.scoped(workspaceId),
			project = options.projectPath(workspaceId);
		if (!project) throw new KnowledgeError("NOT_FOUND", "Registered project unavailable.");
		const all: Source[] = [{ id: "project", root: project, vault: false, project: true }];
		for (const item of config.collections) {
			try {
				all.push({
					id: `shared:${item.id}`,
					root: await safeSourcePath(home, `data/knowledge-collections/shared/${item.id}`),
					sharedPath: `data/knowledge-collections/shared/${item.id}`,
					vault: false,
					project: false,
				});
			} catch {
				/* Missing Shared folders have no readable notes. */
			}
			if (item.obsidianFolder)
				all.push({ id: `obsidian:shared:${item.id}`, root: item.obsidianFolder, vault: true, project: false });
		}
		if (config.obsidianFolder)
			all.push({ id: "obsidian:project", root: config.obsidianFolder, vault: true, project: true });
		return { config, all, fingerprint: JSON.stringify(config) };
	};
	const vault = options.vault ?? (async () => createScopedObsidianReader(await createObsidianConnectorStore().read()));
	const makeNote = (source: Source, path: string, content: string, tags: string[]): DiscoveryNote => ({
		collection: source.id,
		path,
		revision: hashKnowledgeContent(content),
		title: (describeKnowledgeMarkdown(content).sections[0]?.title ?? path).slice(0, 200),
		tags: tags.slice(0, 40),
		snippet: describeKnowledgeMarkdown(content).text.slice(0, 300),
	});
	const checkPolicy = async (workspaceId: string, fingerprint: string) => {
		if (JSON.stringify(await policy.scoped(workspaceId)) !== fingerprint)
			throw new KnowledgeError(
				"CONFLICT",
				"Reference access changed during discovery; reload within the current scope.",
			);
	};
	const load = async (source: Source, path: string, reader?: ScopedObsidianReader): Promise<Loaded> => {
		if (source.vault) {
			if (!reader)
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"Optional vault source unavailable; project/shared Markdown remains usable.",
				);
			const raw = await reader.read(`${source.root}/${discoveryPathSchema.parse(path)}`);
			return {
				source,
				content: raw.content,
				note: makeNote(source, path, raw.content, raw.tags),
				links: raw.links,
				backlinks: raw.backlinks,
			};
		}
		const content = await readSourceMarkdown(
				source.sharedPath ? home : source.root,
				source.sharedPath ? `${source.sharedPath}/${path}` : path,
			),
			facts = markdownFacts(content, path);
		return { source, content, note: makeNote(source, path, content, facts.tags), links: facts.links, backlinks: [] };
	};
	const snapshot = async (workspaceId: string) => {
		const { config, all, fingerprint } = await sources(workspaceId),
			warnings = new Set<string>(config.warning ? [config.warning] : []);
		let reader: ScopedObsidianReader | undefined,
			bytes = 0,
			entries = 0,
			truncated = Boolean(config.warning);
		if (all.some((source) => source.vault)) {
			try {
				reader = await vault();
				warnings.add("vault_graph_completeness_unknown");
			} catch {
				warnings.add("obsidian_unavailable_markdown_fallback");
				truncated = true;
			}
		}
		const loaded: Loaded[] = [];
		try {
			for (const source of all) {
				if (entries >= 1000 || bytes >= 2097152 || loaded.length >= 100) {
					truncated = true;
					break;
				}
				if (source.vault && !reader) continue;
				const paths: string[] = [];
				if (source.vault) {
					const client = reader;
					if (!client) continue;
					const walk = async (folder: string, depth: number): Promise<void> => {
						if (depth > 6 || entries >= 1000) {
							truncated = true;
							return;
						}
						for (const entry of await client.list(folder)) {
							if (++entries > 1000) {
								truncated = true;
								break;
							}
							const directory = entry.endsWith("/"),
								name = directory ? entry.slice(0, -1) : entry;
							if (!discoveryPathSchema.safeParse(name).success || name.includes("/")) continue;
							const full = `${folder}/${name}`;
							if (!full.startsWith(`${source.root}/`)) continue;
							if (directory) await walk(full, depth + 1);
							else if (name.toLowerCase().endsWith(".md")) paths.push(full.slice(source.root.length + 1));
						}
					};
					try {
						await walk(source.root, 0);
					} catch {
						warnings.add("obsidian_unavailable_markdown_fallback");
						truncated = true;
						continue;
					}
				} else {
					const found = await listSourceMarkdown(source.root, source.project, 1000 - entries);
					paths.push(...found.paths);
					entries += found.entries;
					truncated ||= found.truncated;
				}
				for (const path of paths.sort()) {
					if (loaded.length >= 100 || bytes >= 2097152) {
						truncated = true;
						break;
					}
					try {
						const item = await load(source, path, reader),
							size = Buffer.byteLength(item.content);
						if (bytes + size > 2097152) {
							truncated = true;
							bytes = 2097152;
							break;
						}
						bytes += size;
						loaded.push(item);
					} catch {
						warnings.add(source.vault ? "vault_note_unavailable" : "markdown_note_unavailable");
						truncated = true;
					}
				}
			}
		} finally {
			await reader?.close();
		}
		await checkPolicy(workspaceId, fingerprint);
		return { all, loaded, warnings: [...warnings].slice(0, 20), truncated };
	};
	return {
		policy,
		query: async (workspaceId: string, input: { query: string; offset: number; limit: number }) => {
			const data = await snapshot(workspaceId),
				terms = input.query.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean);
			const matches = data.loaded
				.filter((item) =>
					terms.every((term) =>
						`${item.note.title} ${item.content} ${item.note.tags.join(" ")}`
							.normalize("NFKC")
							.toLowerCase()
							.includes(term),
					),
				)
				.map((item) => item.note);
			return {
				notes: matches.slice(input.offset, input.offset + input.limit),
				total: matches.length,
				nextOffset: input.offset + input.limit < matches.length ? input.offset + input.limit : null,
				truncated: data.truncated,
				warnings: data.warnings,
				authority: "mutable_discovery_not_execution_approval" as const,
			};
		},
		read: async (
			workspaceId: string,
			input: DiscoveryPointer & { offset: number; limit: number; section?: string },
		) => {
			const { all, fingerprint } = await sources(workspaceId),
				source = all.find((item) => item.id === input.collection);
			if (!source) throw new KnowledgeError("FORBIDDEN", "That collection is not available to this project.");
			let reader: ScopedObsidianReader | undefined;
			try {
				if (source.vault) reader = await vault();
				const item = await load(source, input.path, reader);
				if (item.note.revision !== input.revision)
					throw new KnowledgeError(
						"CONFLICT",
						"Mutable Markdown changed; discover its new revision explicitly, never substitute it for an attempt pin.",
					);
				const sections = describeKnowledgeMarkdown(item.content).sections,
					section = input.section ? sections.find((item) => item.id === input.section) : null;
				if (input.section && !section)
					throw new KnowledgeError("NOT_FOUND", "That section is absent from this exact source revision.");
				const slice = sliceKnowledgeText(
					section ? item.content.slice(section.start, section.end) : item.content,
					input.offset,
					input.limit,
				);
				await checkPolicy(workspaceId, fingerprint);
				return {
					note: item.note,
					markdown: slice.markdown,
					sections,
					nextOffset: slice.nextOffset,
					authority: "mutable_discovery_not_execution_approval" as const,
				};
			} finally {
				await reader?.close();
			}
		},
		graph: async (workspaceId: string, input: DiscoveryPointer & { depth: number }) => {
			const data = await snapshot(workspaceId),
				byKey = new Map(data.loaded.map((item) => [key(item.note), item])),
				start = byKey.get(key(input));
			if (!start)
				throw new KnowledgeError(
					"NOT_FOUND",
					"Source absent from this scoped bounded graph; query/read the permitted source directly.",
				);
			if (start.note.revision !== input.revision)
				throw new KnowledgeError("CONFLICT", "Source changed before traversal; rediscover its revision.");
			const edges: { from: DiscoveryNote; to: DiscoveryNote }[] = [];
			const target = (item: Loaded, path: string) => {
				if (!discoveryPathSchema.safeParse(path).success) return undefined;
				if (!item.source.vault) return byKey.get(key({ collection: item.note.collection, path }));
				for (const scope of data.all.filter((source) => source.vault)) {
					if (path.startsWith(`${scope.root}/`))
						return byKey.get(key({ collection: scope.id, path: path.slice(scope.root.length + 1) }));
				}
				return undefined;
			};
			for (const item of data.loaded) {
				for (const link of item.links) {
					const to = target(item, link);
					if (to) edges.push({ from: item.note, to: to.note });
				}
				for (const backlink of item.backlinks) {
					const from = target(item, backlink);
					if (from) edges.push({ from: from.note, to: item.note });
				}
			}
			const selected = new Map([[key(start.note), start.note]]);
			let frontier = [start.note],
				truncated = data.truncated;
			for (let depth = 0; depth < input.depth; depth++) {
				const next: DiscoveryNote[] = [];
				for (const node of frontier)
					for (const edge of edges) {
						const peer = key(edge.from) === key(node) ? edge.to : key(edge.to) === key(node) ? edge.from : null;
						if (peer && !selected.has(key(peer))) {
							if (selected.size >= 30) {
								truncated = true;
								continue;
							}
							selected.set(key(peer), peer);
							next.push(peer);
						}
					}
				frontier = next;
			}
			const tags = new Map<string, number>();
			for (const note of selected.values())
				for (const tag of new Set(note.tags)) tags.set(tag, (tags.get(tag) ?? 0) + 1);
			const unique = new Map(
				edges
					.filter((edge) => selected.has(key(edge.from)) && selected.has(key(edge.to)))
					.map((edge) => [
						JSON.stringify([key(edge.from), key(edge.to)]),
						{
							from: { collection: edge.from.collection, path: edge.from.path, revision: edge.from.revision },
							to: { collection: edge.to.collection, path: edge.to.path, revision: edge.to.revision },
						},
					]),
			);
			return {
				nodes: [...selected.values()],
				edges: [...unique.values()].slice(0, 120),
				tags: [...tags].slice(0, 40).map(([tag, count]) => ({ tag, count })),
				truncated: truncated || unique.size > 120 || tags.size > 40,
				warnings: data.warnings,
				authority: "mutable_discovery_not_execution_approval" as const,
			};
		},
	};
}
