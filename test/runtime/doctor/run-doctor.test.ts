import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type DeepCheckDeps, runDeepChecks } from "../../../src/doctor/deep-checks";
import { type DoctorFinding, formatDoctorReport } from "../../../src/doctor/doctor-report";
import { runDoctor } from "../../../src/doctor/run-doctor";
import { addProject } from "../../../src/projects/project-add";
import { listWorkspaceIndexEntries } from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, env: createGitTestEnv(), encoding: "utf8" }).trim();
}

function createRepo(path: string): string {
	mkdirSync(path, { recursive: true });
	git(path, ["init", "-q", "-b", "main"]);
	writeFileSync(join(path, "README.md"), "# repo\n");
	git(path, ["add", "."]);
	git(path, ["commit", "-q", "-m", "init"]);
	return realpathSync(path);
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

const DOCTOR = {
	fix: false,
	deep: false,
	origin: "http://127.0.0.1:3485",
	kanbanVersion: "0.0.0-test",
	// No agent binaries or sandbox probes from the test machine.
	guardrailDeps: { isInstalled: () => false, sandboxAvailable: async () => null },
};

function find(findings: DoctorFinding[], area: DoctorFinding["area"], text: string): DoctorFinding | undefined {
	return findings.find((finding) => finding.area === area && finding.message.includes(text));
}

describe("kanban doctor", () => {
	const savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, KANBAN_KIT_HOME: process.env.KANBAN_KIT_HOME };

	beforeEach(() => {
		delete process.env.KANBAN_KIT_HOME;
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("reports an unregistered target, and --fix adds it on the default kit with landing off", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const repo = createRepo(join(userHomePath, "app"));
			const report = await runDoctor({ ...DOCTOR, target: repo });
			const missing = find(report.findings, "project", "is not a Kanban project");
			expect(missing).toMatchObject({ level: "warn", hint: `kanban project add ${repo}` });
			expect(await listWorkspaceIndexEntries()).toEqual([]);
			expect(find(report.findings, "owner", "no legacy kit")?.level).toBe("pass");

			const fixed = await runDoctor({ ...DOCTOR, target: repo, fix: true });
			expect(fixed.fixes.map((fix) => fix.lines[0])).toContainEqual(
				expect.stringMatching(/^added .*: kit default, landing off$/u),
			);
			const again = await runDoctor({ ...DOCTOR, target: repo });
			expect(find(again.findings, "project", "is not a Kanban project")).toBeUndefined();
			expect(find(again.findings, "project", `(${repo}): kit default, landing off`)?.level).toBe("info");
		});
	});

	it("warns once per registered project outside the projects root, and never for one inside", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath, globalConfigPath }) => {
			const root = join(realpathSync(userHomePath), "projects");
			const inside = createRepo(join(root, "app"));
			const outside = createRepo(join(userHomePath, "legacy-board"));
			// Both registered while the root was the whole temp home (like the legacy kit's board before the rule).
			await addProject({ repoPath: inside });
			await addProject({ repoPath: outside });
			writeJson(globalConfigPath, { projects: { roots: [root] } });

			const report = await runDoctor(DOCTOR);
			const rows = report.findings.filter((finding) => finding.message.includes("outside the projects volume"));
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ level: "warn", area: "project" });
			expect(rows[0]?.message).toContain(`${outside} is outside the projects volume (${root})`);
			// It still works: its info row is there, nothing was removed.
			expect(find(report.findings, "project", `(${outside}): kit default`)?.level).toBe("info");
			expect((await listWorkspaceIndexEntries()).map((entry) => entry.repoPath).sort()).toEqual(
				[inside, outside].sort(),
			);
		});
	});

	it("reports missing Claude Code trust and --fix trusts the main repo", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			process.env.CLAUDE_CONFIG_DIR = join(userHomePath, "claude-config");
			writeJson(join(userHomePath, "claude-config", ".claude.json"), { projects: {} });
			const repo = createRepo(join(userHomePath, "app"));
			// Registration pre-trusts; take it back to see the doctor find it.
			await addProject({ repoPath: repo });
			writeJson(join(userHomePath, "claude-config", ".claude.json"), { projects: {} });
			const report = await runDoctor({ ...DOCTOR, fix: true });
			expect(find(report.findings, "trust", "Claude Code does not trust")?.level).toBe("warn");
			const claude = JSON.parse(readFileSync(join(userHomePath, "claude-config", ".claude.json"), "utf8"));
			expect(claude.projects[repo].hasTrustDialogAccepted).toBe(true);
			const again = await runDoctor(DOCTOR);
			expect(find(again.findings, "trust", "Claude Code trusts")?.level).toBe("pass");
		});
	});

	it("leaves a legacy kit's AGENTS.md section to the kit, and reports the kit's services and landing", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath, globalConfigPath }) => {
			const repo = createRepo(join(userHomePath, "foo"));
			const { workspaceId } = await addProject({ repoPath: repo });
			const legacySection =
				"<!-- kanban-kit:begin agents-qa (kit) -->\nKit text\n<!-- kanban-kit:end agents-qa -->\n";
			writeFileSync(join(repo, "AGENTS.md"), legacySection);
			const kitHome = join(userHomePath, "legacy-kit");
			process.env.KANBAN_KIT_HOME = kitHome;
			writeJson(join(kitHome, "kit.config.json"), {
				projects: [{ workspaceId, projectPath: repo, toggles: { QA_CREATE: true, AUTO_DONE: true } }],
			});
			for (const name of ["autoland", "column-sync", "review-watch", "model-lists"]) {
				writeJson(join(kitHome, "run", `${name}.disabled`), {});
			}
			writeJson(globalConfigPath, { workspaces: { [workspaceId]: { landing: { mode: "qa" } } } });

			const report = await runDoctor({ ...DOCTOR, fix: true });
			const section = find(report.findings, "sections", "agents-qa is the legacy kit's");
			expect(section).toMatchObject({ level: "info" });
			expect(section?.fix).toBeUndefined();
			expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(legacySection);
			expect(find(report.findings, "owner", "autoland disabled")?.level).toBe("info");
			// Every kit service is switched off, so Kanban's landing qa has no second owner.
			expect(report.findings.filter((finding) => finding.level === "fail")).toEqual([]);

			// The kit's autoland back on: two owners.
			rmSync(join(kitHome, "run", "autoland.disabled"));
			const conflict = await runDoctor(DOCTOR);
			expect(find(conflict.findings, "owner", "two owners for landing")?.level).toBe("fail");
			const text = formatDoctorReport(conflict, { verbose: false, fix: false }).join("\n");
			expect(text).toMatch(/^FAIL owner: two owners for landing on /mu);
			expect(text).toMatch(/\d+ checks: 1 fail, /u);
		});
	});

	it("rewrites P2-1's top-level sessionSync boolean into sessionSync.enabled under --fix, keeping the value", async () => {
		await withTemporaryKanbanHome(async ({ globalConfigPath }) => {
			writeJson(globalConfigPath, { selectedAgentId: "claude", sessionSync: false });
			const report = await runDoctor(DOCTOR);
			expect(find(report.findings, "home", 'has the old "sessionSync": false')?.level).toBe("warn");
			expect(JSON.parse(readFileSync(globalConfigPath, "utf8")).sessionSync).toBe(false);
			// Read the same way before and after: session sync stays off.
			expect(find(report.findings, "owner", "session sync is off")?.level).toBe("info");
			await runDoctor({ ...DOCTOR, fix: true });
			expect(JSON.parse(readFileSync(globalConfigPath, "utf8"))).toMatchObject({
				selectedAgentId: "claude",
				sessionSync: { enabled: false },
			});
			expect(find((await runDoctor(DOCTOR)).findings, "home", "sessionSync")).toBeUndefined();
		});
	});

	it("reports worktrees missing the main checkout's pre-push hook, and --fix copies it", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const repo = createRepo(join(userHomePath, "app"));
			mkdirSync(join(repo, ".husky", "_"), { recursive: true });
			writeFileSync(join(repo, ".husky", "_", "h"), "#!/bin/sh\n");
			writeFileSync(join(repo, ".husky", "pre-push"), "#!/bin/sh\nexec scripts/secret-guard.sh\n");
			const worktree = join(userHomePath, "wt");
			git(repo, ["worktree", "add", "-q", "--detach", worktree]);
			await addProject({ repoPath: repo });
			const report = await runDoctor({ ...DOCTOR, fix: true });
			expect(find(report.findings, "hooks", "has no .husky/_, .husky/pre-push")?.level).toBe("warn");
			expect(existsSync(join(worktree, ".husky", "pre-push"))).toBe(true);
			expect(existsSync(join(worktree, ".husky", "_", "h"))).toBe(true);
			expect(find((await runDoctor(DOCTOR)).findings, "hooks", worktree)).toBeUndefined();
		});
	});

	it("fails a project whose git config says core.bare=true, and keeps it registered", async () => {
		await withTemporaryKanbanHome(async ({ userHomePath }) => {
			const repo = createRepo(join(userHomePath, "app"));
			const { workspaceId } = await addProject({ repoPath: repo });
			git(repo, ["config", "core.bare", "true"]);
			const report = await runDoctor(DOCTOR);
			expect(
				find(report.findings, "project", `${workspaceId}: unhealthy, its git config says core.bare=true`),
			).toEqual(expect.objectContaining({ level: "fail", hint: `git -C ${repo} config core.bare false` }));
			expect((await listWorkspaceIndexEntries()).map((entry) => entry.workspaceId)).toEqual([workspaceId]);
		});
	});
});

describe("kanban doctor --deep", () => {
	function deps(overrides: Partial<DeepCheckDeps> = {}): DeepCheckDeps {
		const versions: Record<string, string> = {
			kanban: "0.1.70-fork.4",
			claude: "2.1.291 (Claude Code)",
			cline: "3.0.68",
			git: "git version 2.47.0",
			ssh: "OpenSSH_9.9p1",
		};
		return {
			env: { KANBAN_NO_AUTO_UPDATE: "1", CLINE_NO_AUTO_UPDATE: "1", DISABLE_AUTOUPDATER: "1" },
			isOnPath: (binary) => binary in versions,
			readVersion: async (binary) => versions[binary] ?? null,
			readClineProviders: async () => ({ providers: { bedrock: { settings: { apiKey: "k" } } } }),
			findDeprecatedProviders: async () => [],
			sshKeyPaths: ["/home/.ssh/id_rsa"],
			fileMode: async () => 0o600,
			...overrides,
		};
	}
	const input = {
		kanbanVersion: "0.1.70-fork.4",
		selectedAgentId: "claude" as const,
		defaultProvider: "bedrock",
	};

	it("passes a machine set up like the pod; agents that aren't installed are only info", async () => {
		const findings = await runDeepChecks(input, deps());
		expect(findings.filter((finding) => finding.level === "warn" || finding.level === "fail")).toEqual([]);
		expect(find(findings, "deep", "OpenAI Codex (codex) is not on PATH")?.level).toBe("info");
	});

	it("fails when the selected agent is missing, whichever agent that is", async () => {
		const findings = await runDeepChecks({ ...input, selectedAgentId: "codex" }, deps());
		expect(find(findings, "deep", "OpenAI Codex (codex) is not on PATH")?.level).toBe("fail");
	});

	it("flags an old cline, a different kanban, open ssh key, self-updates, and providers without a key", async () => {
		const findings = await runDeepChecks(
			input,
			deps({
				env: {},
				readVersion: async (binary) =>
					({ kanban: "0.1.69", claude: "2.1", cline: "2.4.0", git: "git version 2", ssh: "OpenSSH" })[binary] ??
					null,
				fileMode: async () => 0o644,
				readClineProviders: async () => ({ providers: { "openai-native": {}, bedrock: { settings: {} } } }),
				findDeprecatedProviders: async () => [
					{
						id: "openai-native",
						file: "/x/providers.json",
						what: "providers.openai-native (openai-native, baseUrl -)",
						note: "Mantle",
						replacement: "bedrock",
						keep: false,
					},
					{
						id: "codex:bedrock-mantle",
						file: "/x/config.toml",
						what: "[model_providers.bedrock-mantle]",
						note: "goes with the Codex retirement",
						replacement: null,
						keep: true,
					},
				],
			}),
		);
		const messages = findings.filter((finding) => finding.level !== "pass").map((finding) => finding.message);
		expect(messages).toEqual(
			expect.arrayContaining([
				"env KANBAN_NO_AUTO_UPDATE is unset: a self-update can change a CLI under running cards",
				"kanban on PATH is 0.1.69, this is 0.1.70-fork.4: agents run a different Kanban",
				"cline --version is 2.4.0; Kanban's Cline agent is the cline 3.x CLI",
				"/home/.ssh/id_rsa has mode 644; ssh refuses a private key others can read",
				"Cline providers.json has no bedrock entry with an apiKey (models.providers.default)",
				"deprecated provider workarounds left: providers.openai-native (openai-native, baseUrl -)",
			]),
		);
		expect(find(findings, "deep", "[model_providers.bedrock-mantle] in /x/config.toml")?.level).toBe("info");
	});
});
