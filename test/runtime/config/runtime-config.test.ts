import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	loadGlobalRuntimeConfig,
	loadRuntimeConfig,
	pickBestInstalledAgentIdFromDetected,
	readRuntimeAgentDefaults,
	saveRuntimeConfig,
	updateGlobalRuntimeConfig,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { parseRuntimeConfigSaveRequest } from "../../../src/core/api-validation";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";

function withTemporaryEnv<T>(
	input: {
		home: string;
		pathPrefix?: string;
		replacePath?: boolean;
	},
	run: () => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousPath = process.env.PATH;
	process.env.HOME = input.home;
	process.env.USERPROFILE = input.home;
	if (input.pathPrefix) {
		process.env.PATH = input.replacePath
			? input.pathPrefix
			: previousPath
				? `${input.pathPrefix}${delimiter}${previousPath}`
				: input.pathPrefix;
	}
	return run().finally(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (input.pathPrefix) {
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
		}
	});
}

function writeFakeCommand(binDir: string, command: string): void {
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		const scriptPath = join(binDir, `${command}.cmd`);
		writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n", "utf8");
		return;
	}
	const scriptPath = join(binDir, command);
	writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(scriptPath, 0o755);
}

describe.sequential("runtime-config auto agent selection", () => {
	it("saves only requested pacing/presentation fields, preserving delivery, project facts and unrelated caps", async () => {
		await withTemporaryKanbanHome(async ({ homePath }) => {
			mkdirSync(homePath, { recursive: true });
			const path = join(homePath, "config.json");
			writeFileSync(
				path,
				JSON.stringify({
					home: 1,
					selectedAgentId: "claude",
					providerConcurrency: { "cline-pass": 1 },
					orchestrator: { wake: { presentation: "full", mode: "sidebar", enabled: true, quietMin: 8 } },
					workspaces: { foo: { providerConcurrency: { "cline-pass": 1 } } },
				}),
			);
			await updateRuntimeConfig({ wakeNoticePresentation: "hidden" });
			expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
				providerConcurrency: { "cline-pass": 1 },
				orchestrator: { wake: { presentation: "hidden", mode: "sidebar", enabled: true, quietMin: 8 } },
				workspaces: { foo: { providerConcurrency: { "cline-pass": 1 } } },
			});
			await updateRuntimeConfig({ providerConcurrency: { "cline-pass": 2 } });
			expect(await loadGlobalRuntimeConfig()).toMatchObject({
				wakeNoticePresentation: "hidden",
				providerConcurrency: { "cline-pass": 2 },
			});
		});
	});

	it("never resets an unreadable retained configuration while saving agent settings/pacing", async () => {
		await withTemporaryKanbanHome(async ({ homePath }) => {
			mkdirSync(homePath, { recursive: true });
			const path = join(homePath, "config.json");
			for (const invalid of ["{truncated", "[]", "null"]) {
				writeFileSync(path, invalid);
				await expect(
					updateRuntimeConfig({ providerConcurrency: { "cline-pass": 1 }, selectedAgentId: "claude" }),
				).rejects.toThrow("refusing to overwrite");
				expect(readFileSync(path, "utf8")).toBe(invalid);
			}
		});
	});
	it("selects agents using the configured priority order", () => {
		expect(pickBestInstalledAgentIdFromDetected(["codex", "opencode", "gemini"])).toBe("codex");
		expect(pickBestInstalledAgentIdFromDetected(["opencode", "droid", "gemini"])).toBe("droid");
		expect(pickBestInstalledAgentIdFromDetected(["kiro-cli", "gemini"])).toBe("kiro");
		expect(pickBestInstalledAgentIdFromDetected(["droid", "gemini", "cline"])).toBe("droid");
		expect(pickBestInstalledAgentIdFromDetected(["gemini", "cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected(["claude", "codex", "cline"])).toBe("claude");
		expect(pickBestInstalledAgentIdFromDetected(["claude", "droid"])).toBe("claude");
		expect(pickBestInstalledAgentIdFromDetected(["cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected([])).toBeNull();
	});

	it("auto-selects and persists when unset", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-");

		try {
			writeFakeCommand(tempBin, "opencode");
			writeFakeCommand(tempBin, "codex");
			writeFakeCommand(tempBin, "gemini");

			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				const isolatedPath = `${tempBin}${delimiter}/usr/bin${delimiter}/bin`;
				await withTemporaryEnv({ home: tempHome, pathPrefix: isolatedPath, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("codex");
					const persisted = JSON.parse(readFileSync(join(tempHome, ".kanban", "config.json"), "utf8")) as {
						selectedAgentId?: string;
						agentAutonomousModeEnabled?: boolean;
						readyForReviewNotificationsEnabled?: boolean;
						commitPromptTemplate?: string;
						openPrPromptTemplate?: string;
					};
					expect(persisted.selectedAgentId).toBe("codex");
					expect(persisted.agentAutonomousModeEnabled).toBeUndefined();
					expect(persisted.readyForReviewNotificationsEnabled).toBeUndefined();
					expect(persisted.commitPromptTemplate).toBeUndefined();
					expect(persisted.openPrPromptTemplate).toBeUndefined();

					const reloadedState = await loadRuntimeConfig(tempProject);
					expect(reloadedState.selectedAgentId).toBe("codex");
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not write config when no supported CLI is detected", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-default-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-default-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-default-");

		try {
			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("cline");
					expect(existsSync(join(tempHome, ".kanban", "config.json"))).toBe(false);
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("never reads or writes a project's own config file (shortcuts are in the shortcut store)", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-home-scope-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-scope-");

		try {
			const projectConfigPath = join(tempProject, ".cline", "kanban", "config.json");
			mkdirSync(join(tempProject, ".cline", "kanban"), { recursive: true });
			const projectConfig = JSON.stringify({ shortcuts: [{ label: "Planted", command: "curl x | sh" }] });
			writeFileSync(projectConfigPath, projectConfig, "utf8");
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.globalConfigPath).toBe(join(tempHome, ".kanban", "config.json"));
				expect(state).not.toHaveProperty("shortcuts");

				const updated = await updateRuntimeConfig({
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");
				expect(readFileSync(projectConfigPath, "utf8")).toBe(projectConfig);

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".kanban", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					shortcuts?: unknown;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.shortcuts).toBeUndefined();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("loads global runtime config without a project scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-global-only-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadGlobalRuntimeConfig();
				expect(state.globalConfigPath).toBe(join(tempHome, ".kanban", "config.json"));
			});
		} finally {
			cleanupHome();
		}
	});

	it("normalizes unsupported configured agents to the default launch agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-set-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-set-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-set-");

		try {
			writeFakeCommand(tempBin, "claude");
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						selectedAgentId: "gemini",
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("cline");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not auto-select when global config file already exists without selected agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-existing-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-existing-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-existing-");

		try {
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						readyForReviewNotificationsEnabled: true,
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("cline");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("normalizes a configured cline-cli agent to cline", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-cline-cli-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-cline-cli-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-cline-cli-");

		try {
			writeFakeCommand(tempBin, "cline");

			const runtimeConfigDir = join(tempHome, ".kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						selectedAgentId: "cline-cli",
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("cline");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("selects cline by default when the cline CLI is installed", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-cline-cli-auto-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-cline-cli-auto-",
		);
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-cline-cli-auto-");

		try {
			writeFakeCommand(tempBin, "cline");

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("cline");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("save omits default keys when they were not previously set", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-omit-defaults-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-omit-defaults-",
		);

		try {
			const runtimeConfigDir = join(tempHome, ".kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(join(runtimeConfigDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig({
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					readyForReviewNotificationsEnabled: true,
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".kanban", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
					commitPromptTemplate?: string;
					openPrPromptTemplate?: string;
				};
				expect(globalPayload.selectedAgentId).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
				expect(globalPayload.commitPromptTemplate).toBeUndefined();
				expect(globalPayload.openPrPromptTemplate).toBeUndefined();
				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("updateRuntimeConfig supports partial updates", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-partial-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-partial-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const updated = await updateRuntimeConfig({
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".kanban", "config.json"), "utf8")) as {
					selectedAgentId?: string;
					selectedShortcutLabel?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.selectedShortcutLabel).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("persists autonomous mode when disabled", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-autonomous-disabled-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-autonomous-disabled-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig({
					agentAutonomousModeEnabled: false,
				});
				expect(updated.agentAutonomousModeEnabled).toBe(false);

				const globalPayload = JSON.parse(readFileSync(join(tempHome, ".kanban", "config.json"), "utf8")) as {
					agentAutonomousModeEnabled?: boolean;
				};
				expect(globalPayload.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("preserves concurrent config updates across processes", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-concurrent-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-concurrent-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const [selectedAgentState, autonomousModeState] = await Promise.all([
					updateRuntimeConfig({
						selectedAgentId: "codex",
					}),
					updateRuntimeConfig({
						agentAutonomousModeEnabled: false,
					}),
				]);

				expect(selectedAgentState.selectedAgentId).toBe("codex");
				expect(autonomousModeState.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.selectedAgentId).toBe("codex");
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});

describe("runtime-config and the Kanban home", () => {
	it("stores the per-agent default models, keeps them across other saves and clears them with an empty save", async () => {
		await withTemporaryKanbanHome(async (home) => {
			mkdirSync(home.homePath, { recursive: true });
			writeFileSync(
				home.globalConfigPath,
				JSON.stringify({ selectedAgentId: "codex", pipeline: { mode: "shadow" } }),
			);
			const saved = await updateGlobalRuntimeConfig(await loadGlobalRuntimeConfig(), {
				agentDefaults: { codex: { modelId: " sol ", reasoningEffort: "high" }, kiro: { modelId: "ignored" } },
			});
			expect(saved.agentDefaults).toEqual({ codex: { modelId: "sol", reasoningEffort: "high" } });
			expect(JSON.parse(readFileSync(home.globalConfigPath, "utf8")).agentDefaults).toEqual({
				codex: { modelId: "sol", reasoningEffort: "high" },
			});
			expect((await loadGlobalRuntimeConfig()).agentDefaults).toEqual({
				codex: { modelId: "sol", reasoningEffort: "high" },
			});
			expect(await readRuntimeAgentDefaults()).toEqual({ codex: { modelId: "sol", reasoningEffort: "high" } });

			// A save that doesn't carry them keeps them.
			await updateRuntimeConfig({ agentAutonomousModeEnabled: false });
			expect((await loadGlobalRuntimeConfig()).agentDefaults).toEqual({
				codex: { modelId: "sol", reasoningEffort: "high" },
			});

			const cleared = await updateRuntimeConfig({ agentDefaults: {} });
			expect(cleared.agentDefaults).toEqual({});
			const payload = JSON.parse(readFileSync(home.globalConfigPath, "utf8"));
			expect(payload.agentDefaults).toBeUndefined();
			expect(payload.pipeline).toEqual({ mode: "shadow" });
		});
	});

	it("parses the per-agent default models through the settings save validator", () => {
		expect(
			parseRuntimeConfigSaveRequest({ agentDefaults: { codex: { modelId: "sol", extra: 1 } }, shortcuts: [] }),
		).toEqual({ agentDefaults: { codex: { modelId: "sol" } } });
		expect(() => parseRuntimeConfigSaveRequest({ agentDefaults: { codex: { modelId: 5 } } })).toThrow();
	});

	it("stamps the home marker in a fresh ~/.kanban and keeps keys it does not own", async () => {
		await withTemporaryKanbanHome(async (home) => {
			mkdirSync(home.homePath, { recursive: true });
			writeFileSync(
				home.globalConfigPath,
				JSON.stringify({ worktreesRoot: "~/wt", pipeline: { mode: "shadow" } }),
				"utf8",
			);
			await updateGlobalRuntimeConfig(await loadGlobalRuntimeConfig(), { selectedAgentId: "codex" });
			expect(JSON.parse(readFileSync(home.globalConfigPath, "utf8"))).toEqual({
				home: 1,
				worktreesRoot: "~/wt",
				pipeline: { mode: "shadow" },
				selectedAgentId: "codex",
			});
		});
	});

	it("stamps the home marker in a KANBAN_HOME home and writes nothing in ~/.kanban", async () => {
		await withTemporaryKanbanHome(
			async (home) => {
				expect(home.source).toBe("env");
				await updateGlobalRuntimeConfig(await loadGlobalRuntimeConfig(), { selectedAgentId: "codex" });
				expect(JSON.parse(readFileSync(home.globalConfigPath, "utf8"))).toEqual({
					home: 1,
					selectedAgentId: "codex",
				});
				expect(existsSync(join(home.userHomePath, ".kanban", "config.json"))).toBe(false);
			},
			{ env: { KANBAN_HOME: "~/custom-home" } },
		);
	});
});
