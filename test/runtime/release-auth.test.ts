import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("registry-only Actions authentication exception", () => {
	it("publishes npm/GHCR with generated tokens, without direct PAT or Actions-token issue/release writes", () => {
		const root = resolve(__dirname, "../..");
		const image = readFileSync(resolve(root, ".github/workflows/image.yml"), "utf8");
		const publish = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8");
		for (const workflow of [image, publish]) {
			expect(workflow).toContain("packages: write");
			expect(workflow).toContain("contents: read");
			expect(workflow).not.toContain("secrets.GH_PAT");
			expect(workflow).not.toContain("contents: write");
			expect(workflow).not.toContain("issues: write");
		}
		expect(image).toMatch(/password: \$\{\{ github\.token \}\}/u);
		expect(image).toMatch(/username: \$\{\{ github\.actor \}\}/u);
		expect(image.indexOf("Verify generated-token registry scope")).toBeLessThan(
			image.indexOf("Build and test Kanban"),
		);
		expect(publish).toMatch(/NODE_AUTH_TOKEN: \$\{\{ github\.token \}\}/u);
		expect(publish).not.toContain("softprops/action-gh-release");
	});
});
