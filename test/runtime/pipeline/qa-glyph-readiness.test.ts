import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { assertGlyphRaster } from "../../../src/pipeline/qa-glyph-readiness";

describe("glyph readiness (#64)", () => {
	it("rejects a process that paints only a white/solid rectangle", () => {
		const png = new PNG({ width: 200, height: 40 });
		png.data.fill(255);
		expect(() => assertGlyphRaster(png)).toThrow("tooling, not application quality");
		for (let i = 0; i < png.data.length; i += 4) {
			png.data[i] = 0;
			png.data[i + 1] = 0;
			png.data[i + 2] = 0;
		}
		expect(() => assertGlyphRaster(png)).toThrow("glyph ink");
	});
});
