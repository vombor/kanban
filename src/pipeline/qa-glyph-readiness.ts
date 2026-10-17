import type { Page } from "playwright-core";
import { PNG } from "pngjs";

/** Process launch, DOM text and solid-background pixels alone do not prove that fonts can render readable glyphs. */
export async function verifyRenderedGlyphs(page: Page): Promise<void> {
	const locator = page.locator("#qa-glyph-proof");
	const box = await locator.boundingBox();
	if (!box || box.width < 100 || box.height < 20)
		throw new Error(
			"Shared Chrome glyph readiness failed: text has collapsed dimensions (tooling, not application quality)",
		);
	assertGlyphRaster(PNG.sync.read(await locator.screenshot()));
}

export function assertGlyphRaster(png: PNG): void {
	let ink = 0;
	for (let offset = 0; offset < png.data.length; offset += 4) {
		if (
			(png.data[offset] ?? 255) < 160 &&
			(png.data[offset + 1] ?? 255) < 160 &&
			(png.data[offset + 2] ?? 255) < 160 &&
			(png.data[offset + 3] ?? 0) > 200
		)
			ink += 1;
	}
	const coverage = ink / (png.width * png.height);
	if (ink < 20 || coverage < 0.005 || coverage > 0.45)
		throw new Error(
			"Shared Chrome glyph readiness failed: no distinguishable rendered glyph ink (tooling, not application quality)",
		);
}
