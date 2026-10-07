import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSetupOrigin } from "../../../src/commands/setup";
import { getKanbanRuntimePort, setKanbanRuntimePort } from "../../../src/core/runtime-endpoint";
import { getClineModelsSettingsPath, getKanbanRunPath } from "../../../src/state/kanban-home";
import { readProcessStartTime } from "../../../src/state/kanban-server-lock";
import { withTemporaryKanbanHome } from "../../utilities/kanban-home";
import { createTempDir } from "../../utilities/temp-dir";

describe("kanban setup", () => {
	const originalPort = getKanbanRuntimePort();
	const originalClineEnv = { CLINE_DIR: process.env.CLINE_DIR, CLINE_DATA_DIR: process.env.CLINE_DATA_DIR };

	afterEach(() => {
		setKanbanRuntimePort(originalPort);
		for (const [key, value] of Object.entries(originalClineEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("finds Cline's models.json the way the Cline CLI does", async () => {
		await withTemporaryKanbanHome(({ userHomePath }) => {
			delete process.env.CLINE_DIR;
			delete process.env.CLINE_DATA_DIR;
			expect(getClineModelsSettingsPath()).toBe(join(userHomePath, ".cline", "data", "settings", "models.json"));
			process.env.CLINE_DIR = "/opt/cline";
			expect(getClineModelsSettingsPath()).toBe("/opt/cline/data/settings/models.json");
			process.env.CLINE_DATA_DIR = "/srv/cline-data";
			expect(getClineModelsSettingsPath()).toBe("/srv/cline-data/settings/models.json");
		});
	});

	it("prefers --origin, then --port, then the running server, then the runtime port", () => {
		const { path: homePath, cleanup } = createTempDir("kanban-setup-home-");
		try {
			setKanbanRuntimePort(3999);
			expect(resolveSetupOrigin({ homePath })).toEqual({ origin: "http://127.0.0.1:3999", source: "port" });

			// This test process stands in for a live server of another home: a record for our own pid is ignored.
			mkdirSync(getKanbanRunPath(homePath), { recursive: true });
			writeFileSync(
				join(getKanbanRunPath(homePath), "server.json"),
				JSON.stringify({
					pid: process.ppid,
					url: "http://127.0.0.1:3485/some-workspace",
					homePath,
					startedAt: Date.now(),
					processStartTime: readProcessStartTime(process.ppid),
				}),
			);
			expect(resolveSetupOrigin({ homePath })).toEqual({ origin: "http://127.0.0.1:3485", source: "server" });
			expect(resolveSetupOrigin({ homePath, portFlag: { mode: "fixed", value: 4000 } })).toEqual({
				origin: "http://127.0.0.1:4000",
				source: "port",
			});
			expect(
				resolveSetupOrigin({ homePath, originFlag: "http://kanban.local:80/x", portFlag: { mode: "auto" } }),
			).toEqual({ origin: "http://kanban.local", source: "flag" });
		} finally {
			cleanup();
		}
	});
});
