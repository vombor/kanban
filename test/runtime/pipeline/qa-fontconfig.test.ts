import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";

import { buildRelocatedFontconfig, inspectQaFontconfig, repairQaFontconfig } from "../../../src/pipeline/qa-fontconfig";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "kanban-font-relocation-"));
	const vendor = join(root, "new & relocated", "vendor", "chromium-libs");
	const fonts = join(vendor, "root/usr/share/fonts/truetype");
	mkdirSync(fonts, { recursive: true });
	writeFileSync(join(fonts, "fixture.ttf"), "fixture-font-path");
	const source = `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><!-- user customization --><dir>${root}/old/vendor/chromium-libs/root/usr/share/fonts</dir><cachedir>${root}/old/vendor/chromium-libs/fontcache</cachedir><alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias></fontconfig>`;
	writeFileSync(join(vendor, "fonts.conf"), source);
	return { root, vendor, source };
}

describe("retained Fontconfig relocation (#64)", () => {
	it("reports stale paths without changing any file", () => {
		const { vendor, source } = fixture();
		const result = inspectQaFontconfig(vendor);
		expect(result.fontFilesReadable).toBe(true);
		expect(result.issues.join(" ")).toContain("old/vendor/chromium-libs");
		expect(readFileSync(join(vendor, "fonts.conf"), "utf8")).toBe(source);
	});
	it("explicitly backs up and repairs only owned paths while retaining aliases/comments and XML escaping", async () => {
		const { vendor, source } = fixture();
		const result = await repairQaFontconfig(vendor);
		expect(result.issues).toEqual([]);
		expect(readFileSync(result.backupPath ?? "", "utf8")).toBe(source);
		const xml = readFileSync(result.configPath, "utf8");
		expect(xml).toContain('prefix="relative">root/usr/share/fonts');
		expect(xml).toContain("new &amp; relocated");
		expect(xml).toContain("user customization");
		expect(xml).toContain("DejaVu Sans");
		expect(xml).not.toContain("/old/");
	});
	it("is stable on a repeat repair and preserves unrelated custom directories", () => {
		const cache = "/new/custom-bundle/fontcache";
		const once = buildRelocatedFontconfig(
			"<fontconfig><dir>/custom/fonts</dir><alias><family>mono</family></alias></fontconfig>",
			cache,
		);
		const twice = buildRelocatedFontconfig(once, cache);
		const document = new DOMParser().parseFromString(twice, "application/xml");
		expect(document.getElementsByTagName("cachedir").length).toBe(1);
		expect(twice).toContain("/custom/fonts");
		expect(twice).toBe(once);
	});
	it("can regenerate its marked cache path after a second relocation", () => {
		const once = buildRelocatedFontconfig(null, "/one/custom-bundle/fontcache");
		const twice = buildRelocatedFontconfig(once, "/two/custom-bundle/fontcache");
		expect(twice).not.toContain("/one/");
		expect(twice).toContain("/two/");
	});
	it("refuses malformed XML without overwriting it", async () => {
		const { vendor } = fixture();
		const broken = "<fontconfig><dir>unterminated";
		writeFileSync(join(vendor, "fonts.conf"), broken);
		await expect(repairQaFontconfig(vendor)).rejects.toThrow("malformed");
		expect(readFileSync(join(vendor, "fonts.conf"), "utf8")).toBe(broken);
	});
});
