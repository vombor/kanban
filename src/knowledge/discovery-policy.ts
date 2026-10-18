import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { renameDurably, writeFileSynced } from "../fs/durable-file";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	getKanbanHomePath,
	getKnowledgeDiscoveryPaths,
	getKnowledgeSourcePolicyPath,
	getReservedDataDirNames,
} from "../state/kanban-home";
import { knowledgeIdSchema } from "../trpc/knowledge-contract";
import {
	type DiscoveryCollection,
	discoveryCollectionSchema,
	discoveryPathSchema,
} from "../trpc/knowledge-discovery-contract";
import { readKnowledgeFile } from "./content-store";
import { KnowledgeError } from "./knowledge-error";

const projectHistory = z
	.object({
		revision: z.string().nullable(),
		shared: z.array(knowledgeIdSchema).max(30),
		obsidianFolder: discoveryPathSchema.nullable(),
		changedAt: z.string(),
	})
	.strict();
const globalHistory = z
	.object({
		revision: z.string().nullable(),
		collections: z.array(discoveryCollectionSchema).max(30),
		changedAt: z.string(),
	})
	.strict();
const globalSchema = z
	.object({
		version: z.literal(1),
		revision: z.string().nullable(),
		collections: z.array(discoveryCollectionSchema).max(30),
		history: z.array(globalHistory).max(500).default([]),
	})
	.strict();
const policySchema = z
	.object({
		version: z.literal(1),
		revision: z.string().nullable(),
		shared: z.array(knowledgeIdSchema).max(30),
		obsidianFolder: discoveryPathSchema.nullable(),
		history: z.array(projectHistory).max(500).default([]),
	})
	.strict();
type Policy = z.infer<typeof policySchema>;
const empty = (): Policy => ({ version: 1, revision: null, shared: [], obsidianFolder: null, history: [] });
async function readJson(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readKnowledgeFile(path, 262144));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw new KnowledgeError(
			"PRECONDITION_FAILED",
			"Knowledge source policy is unreadable; existing grants were not overwritten.",
		);
	}
}
async function writeJson(path: string, data: unknown) {
	const text = JSON.stringify(data);
	if (Buffer.byteLength(text) > 262144)
		throw new KnowledgeError(
			"PRECONDITION_FAILED",
			"Source-policy history ceiling reached; no grant history was evicted.",
		);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFileSynced(tmp, text, { mode: 0o600, flag: "wx" });
		await renameDurably(tmp, path);
	} finally {
		await rm(tmp, { force: true });
	}
}
function overlaps(a: string, b: string) {
	const x = a.normalize("NFKC").toLowerCase(),
		y = b.normalize("NFKC").toLowerCase();
	return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
export function createDiscoveryPolicyStore(homePath = getKanbanHomePath()) {
	const paths = getKnowledgeDiscoveryPaths(homePath);
	const global = async () =>
		globalSchema.parse((await readJson(paths.manifest)) ?? { version: 1, revision: null, collections: [] });
	const project = async (workspaceId: string) =>
		policySchema.parse((await readJson(getKnowledgeSourcePolicyPath(workspaceId, homePath))) ?? empty());
	const validate = async (
		collections: DiscoveryCollection[],
		replacement?: { workspaceId: string; policy: Policy },
	) => {
		if (new Set(collections.map((item) => item.id)).size !== collections.length)
			throw new KnowledgeError("CONFLICT", "Shared collection ids must be unique.");
		const folders = collections.flatMap((item) =>
			item.obsidianFolder ? [{ owner: `shared:${item.id}`, folder: item.obsidianFolder }] : [],
		);
		let entries: string[] = [];
		try {
			entries = (await readdir(join(homePath, "data"), { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
				.map((entry) => entry.name);
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		for (const id of entries) {
			if (getReservedDataDirNames().includes(id) || id.startsWith(".") || id === replacement?.workspaceId) continue;
			const policy = await project(id);
			if (policy.obsidianFolder) folders.push({ owner: `project:${id}`, folder: policy.obsidianFolder });
		}
		if (replacement?.policy.obsidianFolder)
			folders.push({ owner: `project:${replacement.workspaceId}`, folder: replacement.policy.obsidianFolder });
		for (let i = 0; i < folders.length; i++)
			for (let j = i + 1; j < folders.length; j++) {
				const a = folders[i],
					b = folders[j];
				if (a && b && overlaps(a.folder, b.folder))
					throw new KnowledgeError(
						"CONFLICT",
						"Private-project and Shared vault folders must not overlap; no scope was broadened.",
					);
			}
	};
	const view = async (workspaceId: string) => {
		const [g, p] = await Promise.all([global(), project(workspaceId)]);
		return {
			globalRevision: g.revision,
			projectRevision: p.revision,
			collections: g.collections,
			shared: p.shared,
			obsidianFolder: p.obsidianFolder,
		};
	};
	return {
		view,
		scoped: async (workspaceId: string) => {
			try {
				const data = await view(workspaceId);
				return {
					...data,
					collections: data.collections.filter((item) => data.shared.includes(item.id)),
					warning: null,
				};
			} catch {
				return {
					globalRevision: null,
					projectRevision: null,
					collections: [] as DiscoveryCollection[],
					shared: [],
					obsidianFolder: null,
					warning: "sharing_configuration_unavailable",
				};
			}
		},
		saveProject: async (
			workspaceId: string,
			input: {
				globalRevision: string | null;
				projectRevision: string | null;
				shared: string[];
				obsidianFolder: string | null;
			},
		) =>
			lockedFileSystem.withLock({ path: paths.manifest }, async () => {
				const [g, p] = await Promise.all([global(), project(workspaceId)]);
				if (g.revision !== input.globalRevision || p.revision !== input.projectRevision)
					throw new KnowledgeError("CONFLICT", "Source policy changed; reload before changing project opt-ins.");
				if (
					new Set(input.shared).size !== input.shared.length ||
					input.shared.some((id) => !g.collections.some((item) => item.id === id))
				)
					throw new KnowledgeError("BAD_REQUEST", "Select known unique Shared collections explicitly.");
				const next = policySchema.parse({
					version: 1,
					revision: randomUUID(),
					shared: input.shared,
					obsidianFolder: input.obsidianFolder,
					history: [
						...p.history,
						{
							revision: p.revision,
							shared: p.shared,
							obsidianFolder: p.obsidianFolder,
							changedAt: new Date().toISOString(),
						},
					],
				});
				await validate(g.collections, { workspaceId, policy: next });
				await writeJson(getKnowledgeSourcePolicyPath(workspaceId, homePath), next);
				return view(workspaceId);
			}),
		addCollection: async (
			workspaceId: string,
			input: { globalRevision: string | null; collection: DiscoveryCollection },
		) =>
			lockedFileSystem.withLock({ path: paths.manifest }, async () => {
				const current = await global();
				if (current.revision !== input.globalRevision)
					throw new KnowledgeError("CONFLICT", "Shared definitions changed; reload before adding a collection.");
				if (current.collections.some((item) => item.id === input.collection.id))
					throw new KnowledgeError(
						"CONFLICT",
						"Collection identities/mappings are immutable; use a new id for a different mapping.",
					);
				const next = globalSchema.parse({
					...current,
					revision: randomUUID(),
					collections: [...current.collections, input.collection],
					history: [
						...current.history,
						{ revision: current.revision, collections: current.collections, changedAt: new Date().toISOString() },
					],
				});
				await validate(next.collections);
				await writeJson(paths.manifest, next);
				return view(workspaceId);
			}),
	};
}
export type DiscoveryPolicyStore = ReturnType<typeof createDiscoveryPolicyStore>;
