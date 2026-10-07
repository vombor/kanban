import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// src/state/kanban-home.ts is the only module that knows where Kanban keeps its home and worktrees.
// This gate fails on hard-coded home paths anywhere else in shipped code (runtime and web UI).
// Tests are not scanned: they have to spell out legacy and fresh layouts on purpose.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCANNED_ROOTS = ["src", join("web-ui", "src")];
const SOURCE_FILE_PATTERN = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[^.]+$/u;

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
	{ label: ".cline/kanban or .cline/worktrees", pattern: /\.cline[\\/]+(?:kanban|worktrees)\b/u },
	{
		label: 'join(".cline", "kanban" | "worktrees")',
		pattern: /["'`]\.cline["'`]\s*,\s*["'`](?:kanban|worktrees)["'`]/u,
	},
	// A path segment: after a separator, quote, backtick or `~`, and before a separator, quote, backtick or
	// the end of the line. File suffixes such as `${configPath}.kanban-<pid>.tmp` are not home paths.
	{ label: ".kanban", pattern: /[\\/"'`~]\.kanban(?=[\\/"'`]|$)/u },
];

// Paths relative to the repo root, with the reason each one may name a home path.
const ALLOWLIST: ReadonlyMap<string, string> = new Map([["src/state/kanban-home.ts", "the home resolver itself"]]);

function listSourceFiles(root: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") {
			continue;
		}
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...listSourceFiles(path));
		} else if (SOURCE_FILE_PATTERN.test(entry.name) && !TEST_FILE_PATTERN.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

describe("kanban home path gate", () => {
	it("keeps hard-coded Kanban home paths inside src/state/kanban-home.ts", () => {
		const violations: string[] = [];
		for (const scannedRoot of SCANNED_ROOTS) {
			for (const file of listSourceFiles(join(REPO_ROOT, scannedRoot))) {
				const repoRelativePath = relative(REPO_ROOT, file).split(sep).join("/");
				if (ALLOWLIST.has(repoRelativePath)) {
					continue;
				}
				const lines = readFileSync(file, "utf8").split("\n");
				lines.forEach((line, index) => {
					for (const { label, pattern } of FORBIDDEN_PATTERNS) {
						if (pattern.test(line)) {
							violations.push(`${repoRelativePath}:${index + 1} (${label}): ${line.trim()}`);
						}
					}
				});
			}
		}
		expect(violations, "Ask src/state/kanban-home.ts for the path instead").toEqual([]);
	});

	it("still recognizes the forms it is meant to catch", () => {
		const samples = [
			'join(homedir(), ".cline", "kanban")',
			"~/.cline/worktrees",
			'join(homedir(), ".kanban")',
			"~/.kanban/worktrees",
			"cd ~/.kanban",
		];
		for (const sample of samples) {
			expect(FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(sample))).toBe(true);
		}
		const nonPaths = [
			'join(cwd, ".cline", "rules")',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal
			"const tempPath = `${configPath}.kanban-${process.pid}.tmp`;",
		];
		for (const sample of nonPaths) {
			expect(FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(sample))).toBe(false);
		}
	});
});
