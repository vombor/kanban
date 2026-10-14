import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePipelineConfig } from "../../../src/config/pipeline-config";

const root = resolve(__dirname, "../../..");

describe("bare product/install boundary", () => {
	it("has no seeded projects or named provider endpoints", () => {
		const config = parsePipelineConfig({}).config;
		expect(config.workspaces).toEqual({});
		expect(config.providers).toEqual({ openaiCompatible: {} });
	});

	it("keeps instance identities out of shipped runtime source, maps and deployment defaults", () => {
		for (const directory of ["src", "web-ui/src", "kits", "assets", "deploy"]) {
			const base = join(root, directory);
			for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
				if (
					!entry.isFile() ||
					/\.test\./u.test(entry.name) ||
					!/\.(tsx?|json|sh|mjs)$|^Containerfile$/u.test(entry.name)
				)
					continue;
				const path = join(entry.parentPath, entry.name);
				const text = readFileSync(path, "utf8");
				expect(text, path).not.toMatch(
					/kanban-2uge|tailedf020|\/mnt\/media|\bfoo\b|\bnotes['’]|\bnotes [a-f0-9]{5}/u,
				);
			}
		}
	});
});
