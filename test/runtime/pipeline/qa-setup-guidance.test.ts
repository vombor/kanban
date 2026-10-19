import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildQaSetupGuidance } from "../../../src/pipeline/qa-setup-guidance";
import { createGitTestEnv } from "../../utilities/git-env";
import { createLandRepo } from "../../utilities/land-repo";

describe("executable QA setup supplement (#61)", () => {
	let repo: ReturnType<typeof createLandRepo> | undefined;
	afterEach(() => repo?.cleanup());
	it("quotes executable extraction/diff examples and treats database setup notes as prose", () => {
		const note = buildQaSetupGuidance({
			repoPath: "/projects/with space",
			snapshot: "012345",
			baseRef: "main",
			scratchDir: "/scratch/qa001",
			outboxDir: "/out/qa001",
			qaTaskId: "qa001",
			dbSetupNotes: "Use the seeded isolated database; read README first.",
		});
		expect(note).toContain("git -C '/projects/with space' diff --stat");
		expect(note).toContain("archive '012345' | tar -x -C '/scratch/qa001'");
		expect(note).toContain("(cd '/scratch/qa001' && unset NODE_ENV && if test -f package.json;");
		expect(note).toContain("if test -f package-lock.json || test -f npm-shrinkwrap.json; then npm ci --include=dev;");
		expect(note).toContain("README-only/non-application baseline needs NO dependency installation");
		expect(note).toContain("continue all real candidate checks and browser acceptance");
		expect(note).not.toContain("&& Use the seeded");
		expect(note).toContain("NOT a shell command");
		expect(note).toContain("current_database()");
		expect(note).toContain("Do NOT put these dependent commands in a parallel");
	});

	it("executes its generated extraction commands against an isolated real repo and refuses overwriting evidence", () => {
		repo = createLandRepo();
		repo.write(repo.repoPath, "proof.txt", "snapshot evidence");
		repo.commitAll(repo.repoPath, "snapshot proof");
		const snapshot = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo.repoPath,
			env: createGitTestEnv(),
			encoding: "utf8",
		}).trim();
		const scratch = join(repo.root, "reviewer's scratch");
		const note = buildQaSetupGuidance({
			repoPath: repo.repoPath,
			snapshot,
			baseRef: "main",
			scratchDir: scratch,
			outboxDir: join(repo.root, "out"),
			qaTaskId: "qa001",
			dbSetupNotes: "",
		});
		const commands = note.split("```bash\n")[1]?.split("\n```")[0];
		if (!commands) throw new Error("Missing generated Bash commands");
		execFileSync("bash", ["-c", commands], { env: createGitTestEnv(), stdio: "pipe" });
		expect(readFileSync(join(scratch, "proof.txt"), "utf8")).toBe("snapshot evidence");
		expect(existsSync(join(`${scratch}-main`, "proof.txt"))).toBe(true);
		expect(() => execFileSync("bash", ["-c", commands], { env: createGitTestEnv(), stdio: "pipe" })).toThrow();
		expect(readFileSync(join(scratch, "proof.txt"), "utf8")).toBe("snapshot evidence");
	});

	it("installs only the application candidate when the exact baseline is README-only (#68)", () => {
		repo = createLandRepo();
		repo.git(["rm", "src/app.ts"]);
		const base = repo.commitAll(repo.repoPath, "README-only baseline");
		repo.write(repo.repoPath, "package.json", '{"name":"owned-qa-fixture","private":true}');
		repo.write(repo.repoPath, "package-lock.json", "{}");
		const snapshot = repo.commitAll(repo.repoPath, "application candidate");
		const scratch = join(repo.root, "candidate"),
			bin = join(repo.root, "fake-bin"),
			log = join(repo.root, "npm.log");
		mkdirSync(bin);
		const npm = join(bin, "npm");
		writeFileSync(
			npm,
			'#!/bin/sh\n[ -f package.json ] || exit 99\nprintf "%s\\n" "$PWD:$*" >> "$QA_OWNED_LOG"\n[ "$QA_FAIL_INSTALL" = 0 ] || exit 23\n',
		);
		chmodSync(npm, 0o700);
		const note = buildQaSetupGuidance({
			repoPath: repo.repoPath,
			snapshot,
			baseRef: base,
			scratchDir: scratch,
			outboxDir: join(repo.root, "out"),
			qaTaskId: "qa001",
			dbSetupNotes: "The exact base is non-application; do not invent a baseline server.",
		});
		const blocks = [...note.matchAll(/```bash\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
		const extraction = blocks[0],
			setup = blocks[1];
		if (!extraction || !setup) throw new Error("Missing owned commands");
		const env = createGitTestEnv({ PATH: `${bin}:${process.env.PATH}`, QA_OWNED_LOG: log, QA_FAIL_INSTALL: "0" });
		execFileSync("bash", ["-c", extraction], { env, stdio: "pipe" });
		const output = execFileSync("bash", ["-c", setup], { env, encoding: "utf8" });
		expect(readFileSync(log, "utf8").trim()).toBe(`${scratch}:ci --include=dev`);
		expect(output).toContain("NPM_SETUP_NOT_RUN: baseline: no package.json");
		expect(existsSync(join(`${scratch}-${base}`, "package.json"))).toBe(false);
		expect(() =>
			execFileSync("bash", ["-c", setup], { env: { ...env, QA_FAIL_INSTALL: "1" }, stdio: "pipe" }),
		).toThrow();
	});
});
