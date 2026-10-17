import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
		expect(note).toContain("(cd '/scratch/qa001' && unset NODE_ENV && npm ci --include=dev)");
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
});
