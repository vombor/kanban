import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkKanbanFilesUnderClineDir } from "../../../src/doctor/cline-dir-checks";
import { CLINE_RULE_FILES } from "../../../src/prompts/cline-rules";
import { createTempDir } from "../../utilities/temp-dir";

describe("doctor: Kanban files under Cline's dir", () => {
	let root: string;
	let cleanup: () => void;
	let rulesDir: string;
	let settingsDir: string;

	beforeEach(() => {
		({ path: root, cleanup } = createTempDir("kanban-cline-dir-checks-"));
		rulesDir = join(root, ".cline", "rules");
		settingsDir = join(root, ".cline", "data", "settings");
	});
	afterEach(() => cleanup());

	function check() {
		return checkKanbanFilesUnderClineDir({ rulesDir, providersPath: join(settingsDir, "providers.json") });
	}

	it("passes when Cline's dir has nothing of Kanban's", async () => {
		const findings = await check();
		expect(findings).toHaveLength(1);
		expect(findings[0]?.level).toBe("pass");
	});

	it("reports Kanban's global rules and setup backups with the rm command, and changes nothing", async () => {
		mkdirSync(rulesDir, { recursive: true });
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(join(rulesDir, "status-line.md"), CLINE_RULE_FILES["status-line.md"] ?? "");
		writeFileSync(join(rulesDir, "keep-acting.md"), "the user's own edit\n");
		writeFileSync(join(rulesDir, "dev-servers.md"), "a project rule\n");
		writeFileSync(join(settingsDir, "providers.json"), "{}");
		writeFileSync(join(settingsDir, "providers.json.bak-before-kanban-setup-20261007T055852Z"), "{}");
		writeFileSync(join(settingsDir, "providers.json.bak-before-openai-native"), "{}");

		const findings = await check();
		expect(findings.map((finding) => finding.level)).toEqual(["warn", "info"]);
		expect(findings[0]?.hint).toBe(`rm '${join(rulesDir, "status-line.md")}'`);
		expect(findings[1]?.hint).toBe(
			`rm '${join(settingsDir, "providers.json.bak-before-kanban-setup-20261007T055852Z")}'`,
		);
		expect(findings.every((finding) => finding.fix === undefined)).toBe(true);
		expect(readdirSync(rulesDir).sort()).toEqual(["dev-servers.md", "keep-acting.md", "status-line.md"]);
		expect(readFileSync(join(rulesDir, "keep-acting.md"), "utf8")).toBe("the user's own edit\n");
	});
});
