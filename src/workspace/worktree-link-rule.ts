// Which git-ignored paths of a project's main checkout a task worktree gets as symlinks (issue #19). A worktree has
// none of the checkout's ignored files, so Kanban links them in (task-worktree.ts) to save every card an install and
// its local config. A link shares one file or directory between the checkout and every card, so only what cards
// read is safe to link: a card that writes through a link writes the main checkout's copy and every other card's.
// foo's cards shared `prisma/dev.db`, `prisma/test.db`, `.next` and `server/dist` that way (2026-10-09, sol 7c059,
// f3b47, f0ba7 replaced the test-database link before their tests ran reliably).
//
// The rule: every ignored path is linked unless it matches the default exclude list below or the project's
// `worktrees.symlinkIgnored.exclude` (a kit project fact); the project's `include` links a default-excluded path
// again, and its `exclude` wins over its `include`. The file named by `checks.envFile` is never linked: each card
// gets its own copy, which the scripted checks then copy from the card's worktree (a link out of the worktree is a
// checks ERROR there, checks-project-env.ts), and which a per-card database URL (`checks.databaseUrlVar`) can edit.
// The `.git`-style blacklist and the Turbopack `node_modules` rule in task-worktree.ts stay in force whatever the
// project says. docs/team/KITS.md "Task worktrees' ignored paths".
import { readPipelineConfig } from "../config/pipeline-config";
import type { KitDocument } from "../kits/kit-schema";
import { loadKitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";

export interface DefaultWorktreeLinkExclude {
	pattern: string;
	why: string;
}

const DATABASE = "a database: cards would share one dev/test database";
const BUILD_OUTPUT = "build output: a card's build would overwrite the main checkout's";
const CACHE = "a cache cards write";
const TEST_OUTPUT = "test output cards write";
const LOG = "logs or scratch files cards write";

/** What a new worktree never links unless the project includes it. Every entry is something cards write. */
export const DEFAULT_WORKTREE_LINK_EXCLUDES: readonly DefaultWorktreeLinkExclude[] = [
	{ pattern: "*.db", why: DATABASE },
	{ pattern: "*.db3", why: DATABASE },
	{ pattern: "*.sqlite*", why: DATABASE },
	{ pattern: "*-journal", why: DATABASE },
	{ pattern: "*-wal", why: DATABASE },
	{ pattern: "*-shm", why: DATABASE },
	{ pattern: ".next", why: BUILD_OUTPUT },
	{ pattern: "next-env.d.ts", why: BUILD_OUTPUT },
	{ pattern: ".nuxt", why: BUILD_OUTPUT },
	{ pattern: ".output", why: BUILD_OUTPUT },
	{ pattern: ".svelte-kit", why: BUILD_OUTPUT },
	{ pattern: "dist", why: BUILD_OUTPUT },
	{ pattern: "build", why: BUILD_OUTPUT },
	{ pattern: "out", why: BUILD_OUTPUT },
	{ pattern: "target", why: BUILD_OUTPUT },
	{ pattern: "*.tsbuildinfo", why: BUILD_OUTPUT },
	{ pattern: ".preview", why: BUILD_OUTPUT },
	{ pattern: ".turbo", why: CACHE },
	{ pattern: ".cache", why: CACHE },
	{ pattern: ".parcel-cache", why: CACHE },
	{ pattern: ".vite", why: CACHE },
	{ pattern: ".eslintcache", why: CACHE },
	{ pattern: "__pycache__", why: CACHE },
	{ pattern: ".pytest_cache", why: CACHE },
	{ pattern: "coverage", why: TEST_OUTPUT },
	{ pattern: ".nyc_output", why: TEST_OUTPUT },
	{ pattern: "test-results", why: TEST_OUTPUT },
	{ pattern: "playwright-report", why: TEST_OUTPUT },
	{ pattern: "*.log", why: LOG },
	{ pattern: "logs", why: LOG },
	{ pattern: "tmp", why: LOG },
	{ pattern: ".tmp", why: LOG },
];

export interface WorktreeLinkRule {
	/** The project's `worktrees.symlinkIgnored.include`. */
	include: string[];
	/** The project's `worktrees.symlinkIgnored.exclude`. */
	exclude: string[];
	/** Files each card gets as its own copy instead of a link (`checks.envFile`), relative to the project. */
	copy: string[];
}

export type IgnoredPathLinkDecision = { action: "link" } | { action: "copy" } | { action: "skip"; reason: string };

export const DEFAULT_WORKTREE_LINK_RULE: WorktreeLinkRule = { include: [], exclude: [], copy: [] };

function normalizeRelativePath(path: string): string {
	return path
		.trim()
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== ".")
		.join("/");
}

function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index] as string;
		if (char === "*" && glob[index + 1] === "*") {
			source += ".*";
			index += 1;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
		}
	}
	return new RegExp(`^${source}$`, "u");
}

/**
 * Whether `relativePath` or one of its parent dirs matches `glob`. A glob without `/` is matched against each path
 * segment (`dist` matches `server/dist`), one with `/` against the path from the project root (`prisma/*.db`).
 */
export function matchesWorktreeLinkGlob(relativePath: string, glob: string): boolean {
	const pattern = normalizeRelativePath(glob);
	const segments = normalizeRelativePath(relativePath).split("/");
	if (!pattern || segments[0] === "") {
		return false;
	}
	const regExp = globToRegExp(pattern);
	if (!pattern.includes("/")) {
		return segments.some((segment) => regExp.test(segment));
	}
	return segments.some((_, index) => regExp.test(segments.slice(0, index + 1).join("/")));
}

export function buildWorktreeLinkRule(kit: Pick<KitDocument, "worktrees" | "checks">): WorktreeLinkRule {
	const settings = kit.worktrees?.symlinkIgnored;
	const envFile = kit.checks?.envFile ? normalizeRelativePath(kit.checks.envFile) : "";
	return {
		include: [...(settings?.include ?? [])],
		exclude: [...(settings?.exclude ?? [])],
		copy: envFile ? [envFile] : [],
	};
}

/** Link, copy or skip an ignored path of the main checkout (a git-ignored root, relative to the project). */
export function decideIgnoredPathLink(relativePath: string, rule: WorktreeLinkRule): IgnoredPathLinkDecision {
	const path = normalizeRelativePath(relativePath);
	for (const copyPath of rule.copy) {
		if (copyPath === path) {
			return { action: "copy" };
		}
		if (copyPath.startsWith(`${path}/`)) {
			return {
				action: "skip",
				reason: `holds checks.envFile ${copyPath}, which each card gets as its own copy`,
			};
		}
	}
	const excluded = rule.exclude.find((glob) => matchesWorktreeLinkGlob(path, glob));
	if (excluded) {
		return { action: "skip", reason: `excluded by worktrees.symlinkIgnored.exclude (${excluded})` };
	}
	if (rule.include.some((glob) => matchesWorktreeLinkGlob(path, glob))) {
		return { action: "link" };
	}
	const byDefault = DEFAULT_WORKTREE_LINK_EXCLUDES.find((entry) => matchesWorktreeLinkGlob(path, entry.pattern));
	if (byDefault) {
		return { action: "skip", reason: `${byDefault.why} (default exclude ${byDefault.pattern})` };
	}
	return { action: "link" };
}

/**
 * The workspace's rule from its resolved kit. A config.json or kit that can't be read gives the default rule: it
 * links less than the old link-everything, never more.
 */
export async function loadWorktreeLinkRule(workspaceId: string): Promise<WorktreeLinkRule> {
	try {
		const [{ config }, catalog] = await Promise.all([readPipelineConfig(), loadKitCatalog()]);
		return buildWorktreeLinkRule(resolveWorkspaceKit(config, workspaceId, catalog).kit);
	} catch {
		return DEFAULT_WORKTREE_LINK_RULE;
	}
}
