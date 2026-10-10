import { describe, expect, it } from "vitest";

import { kitDocumentObjectSchema } from "../../../src/kits/kit-schema";
import {
	buildWorktreeLinkRule,
	DEFAULT_WORKTREE_LINK_RULE,
	decideIgnoredPathLink,
	matchesWorktreeLinkGlob,
} from "../../../src/workspace/worktree-link-rule";

function action(path: string, rule = DEFAULT_WORKTREE_LINK_RULE): string {
	return decideIgnoredPathLink(path, rule).action;
}

describe("worktree link rule", () => {
	it("doesn't link databases, build and cache outputs by default (issue #19's foo paths)", () => {
		for (const path of [
			"prisma/dev.db",
			"prisma/test.db",
			"prisma/test-worktree.db",
			"prisma/dev.db-journal",
			"data/app.sqlite",
			"data/app.sqlite3",
			"data/app.db-wal",
			"data/app.db-shm",
			".next",
			"server/dist",
			"dist",
			"build",
			".preview",
			"tsconfig.tsbuildinfo",
			"next-env.d.ts",
			".turbo",
			".cache",
			".parcel-cache",
			"coverage",
			"npm-debug.log",
		]) {
			expect(action(path), path).toBe("skip");
		}
	});

	it("links what cards only read by default", () => {
		for (const path of [".env", ".env.local", ".husky/_", ".cline", ".npmrc"]) {
			expect(action(path), path).toBe("link");
		}
	});

	it("doesn't link installed packages: an install in a card would empty the main checkout's", () => {
		for (const path of ["node_modules", "web-ui/node_modules", "tools/preview/node_modules", ".venv", "venv"]) {
			const decision = decideIgnoredPathLink(path, DEFAULT_WORKTREE_LINK_RULE);
			expect(decision, path).toEqual({ action: "skip", reason: expect.stringContaining("installed packages") });
		}
	});

	it("says why a path isn't linked", () => {
		const decision = decideIgnoredPathLink("prisma/dev.db", DEFAULT_WORKTREE_LINK_RULE);
		expect(decision).toEqual({ action: "skip", reason: expect.stringContaining("default exclude *.db") });
	});

	it("adds the project's excludes and lets its includes link a default-excluded path; exclude wins", () => {
		const rule = buildWorktreeLinkRule({
			worktrees: {
				symlinkIgnored: { include: [".cache", "dist", "uploads"], exclude: ["node_modules", "uploads"] },
			},
		});
		expect(action(".cache", rule)).toBe("link");
		expect(action("server/dist", rule)).toBe("link");
		expect(action("node_modules", rule)).toBe("skip");
		expect(decideIgnoredPathLink("uploads", rule)).toEqual({
			action: "skip",
			reason: "excluded by worktrees.symlinkIgnored.exclude (uploads)",
		});
		expect(action("prisma/dev.db", rule)).toBe("skip");
		expect(action(".env", rule)).toBe("link");
	});

	it("copies checks.envFile and doesn't link an ignored directory that holds it", () => {
		const rule = buildWorktreeLinkRule({ checks: { envFile: "config/.env" } });
		expect(action("config/.env", rule)).toBe("copy");
		expect(decideIgnoredPathLink("config", rule)).toEqual({
			action: "skip",
			reason: "holds checks.envFile config/.env, which each card gets as its own copy",
		});
		expect(action(".env", rule)).toBe("link");
		const excluded = buildWorktreeLinkRule({
			checks: { envFile: ".env" },
			worktrees: { symlinkIgnored: { exclude: [".env*"] } },
		});
		expect(action(".env", excluded)).toBe("copy");
	});

	it("matches globs per segment without a slash and from the root with one", () => {
		expect(matchesWorktreeLinkGlob("server/dist", "dist")).toBe(true);
		expect(matchesWorktreeLinkGlob("server/dist", "/dist")).toBe(true);
		expect(matchesWorktreeLinkGlob("prisma/dev.db", "prisma/*.db")).toBe(true);
		expect(matchesWorktreeLinkGlob("other/prisma/dev.db", "prisma/*.db")).toBe(false);
		expect(matchesWorktreeLinkGlob("other/prisma/dev.db", "**/prisma/*.db")).toBe(true);
		expect(matchesWorktreeLinkGlob("apps/web/.next", "apps/*")).toBe(true);
		expect(matchesWorktreeLinkGlob("distribution", "dist")).toBe(false);
		expect(matchesWorktreeLinkGlob("a.b", "a?b")).toBe(true);
		expect(matchesWorktreeLinkGlob("a/b", "a?b")).toBe(false);
	});

	it("is a kit key with a strict shape", () => {
		expect(
			kitDocumentObjectSchema.safeParse({ kit: 1, name: "x", worktrees: { symlinkIgnored: { exclude: ["*.db"] } } })
				.success,
		).toBe(true);
		expect(
			kitDocumentObjectSchema.safeParse({ kit: 1, name: "x", worktrees: { symlinkIgnored: { copy: ["*.db"] } } })
				.success,
		).toBe(false);
	});
});
