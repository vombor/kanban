// The fixed, throwaway smoke-test tasks of `kanban models vet` (docs/team/MODELS.md "Vetting"). Each one lives in
// a scratch git repo in a temp dir (never a project repo, never landed) and needs what real card work needs:
//   - dev: read a file (a codename only NOTES.md has), edit code (fix a bug), run a shell command and the test suite
//     (its summary line goes into RESULT.md), commit, end the turn;
//   - qa: review a small diff against its requirement, run the tests (they pass: the bug is one they don't cover), and
//     write a verdict file in the QA format (`verdict.json`, src/pipeline/qa-verdict.ts); the right verdict is FAIL;
//   - plan: read the code and write a short plan (PLAN.md: numbered steps naming the files), change no code.
// The checks read only the scratch repo, so they are the same for every agent.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readQaVerdictFile } from "../../pipeline/qa-verdict";
import type { VettingRole } from "../vetted-registry";

export interface ScratchFile {
	path: string;
	content: string;
}

export interface VetTask {
	role: VettingRole;
	/** Commits made in order: the files each one writes. */
	commits: Array<{ message: string; files: ScratchFile[] }>;
	/** A value only the scratch repo's files hold, which the agent must report (proves it read them). */
	secret: string;
	prompt: (repoPath: string) => string;
}

export interface VetCheck {
	name: string;
	ok: boolean;
	detail: string;
}

/** What the checks may do in the scratch repo (tests inject fakes). */
export interface VetCheckDeps {
	readText: (path: string) => Promise<string | null>;
	/** `npm test` (node --test) in the repo. */
	runTests: (repoPath: string) => Promise<{ ok: boolean; output: string }>;
	/** `git status --porcelain` and the files changed since the task's last commit (`git diff --name-only <base>`). */
	listChangedFiles: (repoPath: string) => Promise<string[]>;
	/** Commits on top of the task's own commits. */
	countNewCommits: (repoPath: string) => Promise<number>;
}

const PACKAGE_JSON = `${JSON.stringify(
	{ name: "kanban-vet-scratch", private: true, type: "module", scripts: { test: "node --test" } },
	null,
	2,
)}\n`;

const STATUS_LINE = "STATUS: DONE";

function finalStep(): string {
	return `When you are done, end your turn with a last line \`${STATUS_LINE}\`. Don't ask questions: everything you need is in the repo. Work only in that repo; it is a throwaway smoke test, nothing in it is shipped.`;
}

function createDevTask(secret: string): VetTask {
	return {
		role: "dev",
		secret,
		commits: [
			{
				message: "scratch: slugify",
				files: [
					{ path: "package.json", content: PACKAGE_JSON },
					{
						path: "src/slugify.js",
						content: `// Turns a title into a URL slug.\nexport function slugify(text) {\n\treturn text.toLowerCase().replace(/ /g, "-");\n}\n`,
					},
					{
						path: "test/slugify.test.js",
						content: `import assert from "node:assert/strict";\nimport { test } from "node:test";\n\nimport { slugify } from "../src/slugify.js";\n\ntest("lowercases and joins words", () => {\n\tassert.equal(slugify("Hello World"), "hello-world");\n});\n\ntest("drops punctuation and extra spaces", () => {\n\tassert.equal(slugify("  Hello,   World!  "), "hello-world");\n});\n\ntest("keeps digits", () => {\n\tassert.equal(slugify("Top 10 Tips"), "top-10-tips");\n});\n`,
					},
					{
						path: "NOTES.md",
						content: `# Notes\n\nThe release codename is ${secret}.\n`,
					},
				],
			},
		],
		prompt: (repoPath) =>
			[
				`Smoke test of your tools. The git repo ${repoPath} (outside your worktree) holds a tiny Node project. Work there (cd into it):`,
				"1. Read NOTES.md.",
				"2. `npm test` fails: fix src/slugify.js so every test passes. Don't change the tests.",
				"3. Run `npm test` and check that it passes.",
				"4. Write RESULT.md with two lines: `codename: <the release codename from NOTES.md>` and `tests: <the summary line with the number of passed tests that npm test printed, e.g. `ℹ pass 3`>`.",
				'5. Commit your changes in that repo (`git add -A && git commit -m "fix slugify"`).',
				finalStep(),
			].join("\n"),
	};
}

const QA_REQUIREMENT =
	"clamp(value, min, max) returns value when it is between min and max, min when it is below, and max when it is above.";

function createQaTask(secret: string): VetTask {
	return {
		role: "qa",
		secret,
		commits: [
			{
				message: "scratch: base",
				files: [
					{ path: "package.json", content: PACKAGE_JSON },
					{ path: "REQUIREMENTS.md", content: `# Requirement\n\n${QA_REQUIREMENT}\n\nReview id: ${secret}\n` },
					{ path: "src/.keep", content: "" },
				],
			},
			{
				message: "add clamp",
				files: [
					{
						path: "src/clamp.js",
						content: `export function clamp(value, min, max) {\n\tif (value < min) {\n\t\treturn min;\n\t}\n\tif (value > max) {\n\t\treturn min;\n\t}\n\treturn value;\n}\n`,
					},
					{
						path: "test/clamp.test.js",
						content: `import assert from "node:assert/strict";\nimport { test } from "node:test";\n\nimport { clamp } from "../src/clamp.js";\n\ntest("keeps a value in range", () => {\n\tassert.equal(clamp(5, 0, 10), 5);\n});\n\ntest("raises a value below the range", () => {\n\tassert.equal(clamp(-3, 0, 10), 0);\n});\n`,
					},
				],
			},
		],
		prompt: (repoPath) =>
			[
				`Smoke test of a QA review. The git repo ${repoPath} (outside your worktree) holds a change to review (cd into it):`,
				"1. Read REQUIREMENTS.md.",
				"2. Review the last commit (`git show HEAD`) against the requirement.",
				"3. Run `npm test`.",
				`4. Write your verdict to ${join(repoPath, "outbox", "verdict.json")} as JSON: {"verdict": "PASS" | "FAIL", "scores": {"spec": 1-5, "correctness": 1-5, "tests": 1-5, "code": 1-5}, "blocking": ["<each problem that must be fixed>"], "notes": "<the review id from REQUIREMENTS.md and one sentence>"}. PASS only if the change meets the requirement.`,
				"Change no code.",
				finalStep(),
			].join("\n"),
	};
}

function createPlanTask(secret: string): VetTask {
	return {
		role: "plan",
		secret,
		commits: [
			{
				message: "scratch: todo app",
				files: [
					{ path: "package.json", content: PACKAGE_JSON },
					{
						path: "src/todos.js",
						content: `const todos = [];\n\nexport function addTodo(title) {\n\tconst todo = { id: todos.length + 1, title, done: false };\n\ttodos.push(todo);\n\treturn todo;\n}\n\nexport function listTodos() {\n\treturn [...todos];\n}\n`,
					},
					{
						path: "src/server.js",
						content: `import { createServer } from "node:http";\n\nimport { addTodo, listTodos } from "./todos.js";\n\nexport const server = createServer((request, response) => {\n\tif (request.method === "GET" && request.url === "/todos") {\n\t\tresponse.end(JSON.stringify(listTodos()));\n\t\treturn;\n\t}\n\tif (request.method === "POST" && request.url === "/todos") {\n\t\tresponse.end(JSON.stringify(addTodo("untitled")));\n\t\treturn;\n\t}\n\tresponse.statusCode = 404;\n\tresponse.end();\n});\n`,
					},
					{
						path: "FEATURE.md",
						content: `# Feature (ticket ${secret})\n\nUsers can mark a todo done and filter the list by done/open.\n`,
					},
				],
			},
		],
		prompt: (repoPath) =>
			[
				`Smoke test of planning. The git repo ${repoPath} (outside your worktree) holds a tiny todo service (cd into it):`,
				"1. Read FEATURE.md and the code under src/.",
				"2. Write PLAN.md: a title line with the ticket id from FEATURE.md, then at least three numbered steps (`1.`, `2.`, ...), each naming the file it changes or adds (src/..., test/...).",
				"3. Change no code: only PLAN.md is new.",
				finalStep(),
			].join("\n"),
	};
}

export function createVetTask(role: VettingRole, secret: string = randomBytes(4).toString("hex")): VetTask {
	const codename = `vet-${secret}`;
	switch (role) {
		case "qa":
			return createQaTask(codename);
		case "plan":
			return createPlanTask(codename);
		default:
			return createDevTask(codename);
	}
}

/** Writes one commit's files under the repo (the caller commits). */
export async function writeScratchFiles(repoPath: string, files: ScratchFile[]): Promise<void> {
	for (const file of files) {
		const path = join(repoPath, file.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.content, "utf8");
	}
}

function check(name: string, ok: boolean, detail: string): VetCheck {
	return { name, ok, detail };
}

/** Whether the agent did the task: the role's own checks on the scratch repo. */
export async function checkVetTask(task: VetTask, repoPath: string, deps: VetCheckDeps): Promise<VetCheck[]> {
	const changed = await deps.listChangedFiles(repoPath);
	switch (task.role) {
		case "dev": {
			const result = (await deps.readText(join(repoPath, "RESULT.md"))) ?? "";
			const tests = await deps.runTests(repoPath);
			return [
				check(
					"file read",
					result.includes(task.secret),
					result ? `RESULT.md ${result.includes(task.secret) ? "has" : "lacks"} the codename` : "no RESULT.md",
				),
				check("edit", changed.includes("src/slugify.js"), `changed: ${changed.join(", ") || "nothing"}`),
				check(
					"tests untouched",
					!changed.some((file) => file.startsWith("test/")),
					"the task forbids changing the tests",
				),
				check("test suite", tests.ok, tests.ok ? "npm test passes" : `npm test fails: ${tests.output.slice(-300)}`),
				check(
					"shell command",
					/tests:.*pass\s+3/iu.test(result),
					/tests:/iu.test(result) ? "RESULT.md quotes the test run" : "RESULT.md has no tests line",
				),
				check("commit", (await deps.countNewCommits(repoPath)) > 0, "a commit on top of the scratch commit"),
			];
		}
		case "qa": {
			const read = await readQaVerdictFile(join(repoPath, "outbox"));
			const verdict = read.kind === "ok" ? read.verdict : null;
			return [
				check(
					"verdict file",
					verdict !== null,
					read.kind === "ok" ? "outbox/verdict.json parses" : read.kind === "invalid" ? read.error : "missing",
				),
				check(
					"right verdict",
					verdict?.verdict === "FAIL" && verdict.blocking.length > 0,
					verdict ? `${verdict.verdict}, ${verdict.blocking.length} blocking` : "no verdict",
				),
				check("file read", (verdict?.notes ?? "").includes(task.secret), "notes quote the review id"),
				check(
					"no code change",
					!changed.some((file) => file.startsWith("src/") || file.startsWith("test/")),
					`changed: ${changed.join(", ") || "nothing"}`,
				),
			];
		}
		default: {
			const plan = (await deps.readText(join(repoPath, "PLAN.md"))) ?? "";
			const steps = plan.split("\n").filter((line) => /^\s*\d+\.\s+\S/u.test(line));
			return [
				check("plan written", plan.length > 0, plan ? `PLAN.md, ${steps.length} numbered step(s)` : "no PLAN.md"),
				check("steps", steps.length >= 3, "at least three numbered steps"),
				check(
					"names files",
					steps.filter((line) => /\b(?:src|test)\//u.test(line)).length >= 2,
					"steps name the files they change",
				),
				check("file read", plan.includes(task.secret), "the title has the ticket id"),
				check(
					"no code change",
					changed.every((file) => file === "PLAN.md"),
					`changed: ${changed.join(", ") || "nothing"}`,
				),
			];
		}
	}
}

/** Reads a file, or null when it doesn't exist. */
export async function readTextIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}
