import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json" with { type: "json" };
import { BUILT_IN_KIT_NAMES, getBuiltInKits, getBuiltInPresets } from "../../../src/kits/resolve-kit";

describe("product kit boundary", () => {
	it("ships only the standard default/team kits and model-only presets, never an installation-specific team copy", async () => {
		expect(packageJson.files).toContain("kits");
		const files = await readdir(fileURLToPath(new URL("../../../kits", import.meta.url)));
		expect(files.filter((name) => name.endsWith(".json")).sort()).toEqual(["default.json", "team.json"]);
		expect(BUILT_IN_KIT_NAMES).toEqual(["default", "team"]);
		expect([...getBuiltInKits().keys()]).toEqual(["default", "team"]);
		expect([...getBuiltInPresets().keys()]).toEqual(["cloud", "cline", "lemonade"]);
	});
});
