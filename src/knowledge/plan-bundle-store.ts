import { lstat, mkdir } from "node:fs/promises";
import { getPlanSpecPaths, type PlanBreakdown, parsePlanBreakdown } from "../plans/plan-breakdown";
import { getProjectKnowledgePaths } from "../state/kanban-home";
import { knowledgeRevisionSchema } from "../trpc/knowledge-contract";
import { type PlanBundle, planBundleDefinitionSchema, planBundleSchema } from "../trpc/knowledge-execution-contract";
import { createKnowledgeContentStore, hashKnowledgeContent } from "./content-store";
import { KnowledgeError } from "./knowledge-error";
import { describeKnowledgeRevision, findKnowledgeRevision } from "./knowledge-revisions";
import { createProjectKnowledgeStore, type ProjectKnowledgeStore } from "./knowledge-store";
import { describeKnowledgeMarkdown } from "./markdown";

export interface PreparedPlanBundle {
	bundle: PlanBundle;
	spec: string;
	breakdownText: string;
}
export interface PlanBundleStore {
	prepare(
		workspaceId: string,
		input: {
			planTaskId: string;
			slug: string;
			specPath: string;
			breakdownPath: string;
			spec: string | null;
			breakdownText: string;
			breakdown: PlanBreakdown;
		},
	): Promise<PreparedPlanBundle>;
	persist(workspaceId: string, prepared: PreparedPlanBundle): Promise<PlanBundle>;
	read(workspaceId: string, revision: string): Promise<PlanBundle>;
	readPart(workspaceId: string, hash: string): Promise<string>;
}

/** Private immutable reference objects. Persisting a bundle never grants approval; only the existing user-only plan route does. */
export function createPlanBundleStore(
	options: { homePath?: string; knowledge?: ProjectKnowledgeStore } = {},
): PlanBundleStore {
	const knowledge = options.knowledge ?? createProjectKnowledgeStore({ homePath: options.homePath });
	const content = (workspaceId: string) =>
		createKnowledgeContentStore(getProjectKnowledgePaths(workspaceId, options.homePath).objects);
	const validate = async (workspaceId: string, bundle: PlanBundle) => {
		const { revision, ...definition } = planBundleSchema.parse(bundle);
		if (hashKnowledgeContent(JSON.stringify(planBundleDefinitionSchema.parse(definition))) !== revision)
			throw new KnowledgeError(
				"PRECONDITION_FAILED",
				"The retained plan bundle failed its immutable revision check.",
			);
		for (const part of [bundle.spec, bundle.breakdown]) {
			const text = await content(workspaceId).read(part.contentHash);
			if (Buffer.byteLength(text, "utf8") !== part.contentBytes)
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"A plan bundle part no longer matches its retained content.",
				);
		}
		const manifest = await knowledge.snapshot(workspaceId);
		for (const document of bundle.documents) {
			const actual = describeKnowledgeRevision(findKnowledgeRevision(manifest, document.id, document.revision));
			if (JSON.stringify(actual) !== JSON.stringify(document))
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"Pinned plan knowledge metadata no longer matches its exact retained revision.",
				);
			await knowledge.readContent(workspaceId, document.contentHash);
		}
		return bundle;
	};
	return {
		prepare: async (workspaceId, input) => {
			const parsed = parsePlanBreakdown(input.breakdownText, input.slug);
			const paths = getPlanSpecPaths(input.slug);
			if (
				!parsed.ok ||
				JSON.stringify(parsed.breakdown) !== JSON.stringify(input.breakdown) ||
				paths.specPath !== input.specPath ||
				paths.breakdownPath !== input.breakdownPath
			)
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"Reviewed plan inputs must match their exact valid breakdown and canonical spec paths.",
				);
			if (input.spec === null)
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"The plan spec is missing; full-bundle approval cannot adopt a breakdown alone.",
				);
			describeKnowledgeMarkdown(input.spec);
			const references = [
				...(input.breakdown.knowledgeReferences ?? []),
				...input.breakdown.cards.flatMap((card) => card.knowledgeReferences ?? []),
			];
			const manifest = await knowledge.snapshot(workspaceId),
				byId = new Map<string, string>();
			for (const reference of references) {
				if (byId.has(reference.id) && byId.get(reference.id) !== reference.revision)
					throw new KnowledgeError(
						"CONFLICT",
						"A reviewed plan cannot select conflicting revisions of one knowledge document.",
					);
				byId.set(reference.id, reference.revision);
			}
			for (const versions of Object.values(manifest.documents)) {
				const latest = versions.at(-1);
				if (!latest?.pinnedByUser) continue;
				if (byId.has(latest.document.id) && byId.get(latest.document.id) !== latest.revision)
					throw new KnowledgeError(
						"CONFLICT",
						"A new plan review cannot shadow the user's current pinned decision with another revision.",
					);
				byId.set(latest.document.id, latest.revision);
			}
			if (byId.size > 40)
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"The reviewed plan exceeds 40 selected/user-pinned knowledge documents; split its context explicitly, nothing was dropped.",
				);
			const documents = [];
			for (const [id, revision] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
				const document = describeKnowledgeRevision(findKnowledgeRevision(manifest, id, revision));
				await knowledge.readContent(workspaceId, document.contentHash);
				documents.push(document);
			}
			const part = (text: string, path: string) => ({
				path,
				contentHash: hashKnowledgeContent(text),
				contentBytes: Buffer.byteLength(text, "utf8"),
			});
			const definition = planBundleDefinitionSchema.parse({
				version: 1,
				planTaskId: input.planTaskId,
				slug: input.slug,
				spec: part(input.spec, input.specPath),
				breakdown: part(input.breakdownText, input.breakdownPath),
				documents,
			});
			return {
				bundle: planBundleSchema.parse({
					...definition,
					revision: hashKnowledgeContent(JSON.stringify(definition)),
				}),
				spec: input.spec,
				breakdownText: input.breakdownText,
			};
		},
		persist: async (workspaceId, prepared) => {
			const paths = getProjectKnowledgePaths(workspaceId, options.homePath);
			await mkdir(paths.root, { recursive: true, mode: 0o700 });
			if ((await lstat(paths.root)).isSymbolicLink())
				throw new KnowledgeError("PRECONDITION_FAILED", "Plan bundle storage cannot be a symlink.");
			if (
				hashKnowledgeContent(prepared.spec) !== prepared.bundle.spec.contentHash ||
				hashKnowledgeContent(prepared.breakdownText) !== prepared.bundle.breakdown.contentHash
			)
				throw new KnowledgeError("CONFLICT", "Plan bundle content changed before persistence; review it again.");
			await content(workspaceId).ensure(prepared.spec);
			await content(workspaceId).ensure(prepared.breakdownText);
			await validate(workspaceId, prepared.bundle);
			const { revision, ...definition } = prepared.bundle;
			const stored = await content(workspaceId).ensure(JSON.stringify(planBundleDefinitionSchema.parse(definition)));
			if (stored !== revision)
				throw new KnowledgeError("PRECONDITION_FAILED", "Immutable bundle identity was not retained.");
			return prepared.bundle;
		},
		read: async (workspaceId, revision) => {
			const hash = knowledgeRevisionSchema.parse(revision);
			let definition: unknown;
			try {
				definition = JSON.parse(await content(workspaceId).read(hash));
			} catch {
				throw new KnowledgeError(
					"PRECONDITION_FAILED",
					"The approved plan bundle is missing or unreadable; no mutable worktree fallback is permitted.",
				);
			}
			return validate(
				workspaceId,
				planBundleSchema.parse({ ...planBundleDefinitionSchema.parse(definition), revision: hash }),
			);
		},
		readPart: async (workspaceId, hash) => content(workspaceId).read(knowledgeRevisionSchema.parse(hash)),
	};
}
