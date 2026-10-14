import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSettingsOptions } from "../../../src/core/agent-settings-options";
import { createAgentOptionsLoader } from "../../../src/models/agent-options";
import { readCodexOptions } from "../../../src/models/agent-options/codex-options";
import { parseDroidHelp } from "../../../src/models/agent-options/droid-options";
import { readHelpEfforts } from "../../../src/models/agent-options/local-options";
import { createTempDir } from "../../utilities/temp-dir";

const OPTIONS: AgentSettingsOptions = {
	models: [{ modelId: "native-model", label: "Native model", reasoningEfforts: ["high", "future-effort"] }],
	providers: [],
	efforts: [],
	source: "native",
};

describe("agent picker metadata", () => {
	it("queries only requested agents, deduplicates concurrent reads and refreshes after the cache expires", async () => {
		let now = 0;
		const read = vi.fn(async () => OPTIONS);
		const load = createAgentOptionsLoader(read, () => now);
		await Promise.all([load("claude"), load("claude")]);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith("claude");
		await load("codex");
		expect(read).toHaveBeenCalledTimes(2);
		now = 60_001;
		await load("claude");
		expect(read).toHaveBeenCalledTimes(3);
	});

	it("does not cache failed readers", async () => {
		const read = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(OPTIONS);
		const load = createAgentOptionsLoader(read);
		await expect(load("codex")).rejects.toThrow("unavailable");
		expect(await load("codex")).toEqual(OPTIONS);
	});

	it("uses CLI-advertised thinking values, including future levels", () => {
		expect(
			readHelpEfforts("--thinking <level> Set reasoning effort:\n none|low|medium|high|future", "--thinking"),
		).toEqual(["none", "low", "medium", "high", "future"]);
		expect(readHelpEfforts("No thinking flag", "--thinking")).toEqual([]);
	});

	it("reads Droid IDs and effort lists without maintaining a local model catalog", () => {
		const parsed = parseDroidHelp(
			"Available Models:\n  vendor-model  Vendor Model (default)\n  auto          Auto Model\n\nModel details:\n  - Vendor Model: supports reasoning: Yes; supported: [off, high, new-level]; default: high\n  - Auto Model: supports reasoning: No; supported: [none]; default: none\n\nPinning the Latest Model:",
		);
		expect(parsed.models).toEqual([
			{ modelId: "vendor-model", label: "Vendor Model", reasoningEfforts: ["off", "high", "new-level"] },
			{ modelId: "auto", label: "Auto Model", reasoningEfforts: ["none"] },
		]);
	});
});

describe("Codex native catalog protocol", () => {
	const temps: ReturnType<typeof createTempDir>[] = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) temp.cleanup();
	});
	it("initializes without a turn, follows pagination, and uses the CLI's model/effort metadata", async () => {
		const temp = createTempDir("kanban-model-options-");
		temps.push(temp);
		const binary = join(temp.path, "codex");
		writeFileSync(
			binary,
			`#!/usr/bin/env node
const {createInterface}=require("node:readline");
createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line); if(r.method==="initialize") console.log(JSON.stringify({id:r.id,result:{}})); if(r.method==="model/list") console.log(JSON.stringify({id:r.id,result:{data:[{model:r.params.cursor?"second":"first",displayName:r.params.cursor?"Second":"First",supportedReasoningEfforts:[{reasoningEffort:"ultra"}]}],nextCursor:r.params.cursor?null:"page-2"}}));});
`,
		);
		chmodSync(binary, 0o755);
		const result = await readCodexOptions(binary);
		expect(result.models.map(({ modelId }) => modelId)).toEqual(["first", "second"]);
		expect(result.efforts).toEqual([{ value: "ultra", label: "ultra" }]);
	});
});
