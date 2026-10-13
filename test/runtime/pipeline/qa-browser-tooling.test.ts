import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parsePipelineConfig } from "../../../src/config/pipeline-config";
import { checkQaBrowserTooling } from "../../../src/doctor/qa-browser-tooling-checks";
import { loadKitCatalog } from "../../../src/kits/resolve-kit";
import { buildQaBrowserToolingNote, resolveQaChromiumLibs } from "../../../src/pipeline/qa-browser-tooling";
import { createLandRepo } from "../../utilities/land-repo";

describe("QA browser tooling fallback", () => {
	let repo: ReturnType<typeof createLandRepo> | undefined;
	afterEach(() => repo?.cleanup());

	it("adds scratch-only browser guidance when a project script is missing, and leaves complete tooling alone", () => {
		const input = {
			scripts: ["browse"],
			scratchDir: "/tmp/scratch with spaces",
			outboxDir: "/tmp/out",
			chromiumLibs: "/tmp/home/vendor/chromium-libs",
		};
		const note = buildQaBrowserToolingNote(input);
		expect(note).toContain("no npm run screenshot script");
		expect(note).toContain("--scratch '/tmp/scratch with spaces'");
		expect(note).toContain("QA_CHROMIUM_LIBS=");
		expect(note).toContain("LD_LIBRARY_PATH");
		expect(note).toContain("FONTCONFIG_FILE");
		expect(note).toContain("cached chromium_headless_shell");
		expect(note).toContain("HTTP/code trace alone is insufficient");
		expect(buildQaBrowserToolingNote({ ...input, scripts: ["browse", "screenshot"] })).toBeNull();
	});

	it("uses an explicit Chromium bundle first, otherwise discovers only an installed home bundle", () => {
		repo = createLandRepo();
		expect(resolveQaChromiumLibs(null, repo.root)).toBeNull();
		const vendor = join(repo.root, "vendor/chromium-libs");
		mkdirSync(join(vendor, "root/usr/lib/x86_64-linux-gnu"), { recursive: true });
		expect(resolveQaChromiumLibs(null, repo.root)).toBe(vendor);
		expect(resolveQaChromiumLibs("/explicit/libs", repo.root)).toBe("/explicit/libs");
	});

	it("doctor reads the project's committed tooling, warns when incomplete, and skips kits without QA", async () => {
		repo = createLandRepo();
		const context = {
			config: parsePipelineConfig({ workspaces: { foo: { kit: { name: "team", preset: "cloud" } } } }).config,
			catalog: await loadKitCatalog(join(repo.root, "kits")),
			entries: [{ workspaceId: "foo", repoPath: repo.repoPath }],
		};
		repo.write(repo.repoPath, "package.json", JSON.stringify({ scripts: { browse: "browse" } }));
		repo.commitAll(repo.repoPath, "project tooling");
		expect(await checkQaBrowserTooling(context)).toMatchObject([
			{
				level: "warn",
				message: expect.stringContaining("no screenshot script"),
				hint: expect.stringContaining("does not launch a browser"),
			},
		]);
		repo.write(repo.repoPath, "package.json", JSON.stringify({ scripts: { browse: "browse", screenshot: "shot" } }));
		repo.commitAll(repo.repoPath, "complete tooling");
		expect(await checkQaBrowserTooling(context)).toEqual([]);
		expect(await checkQaBrowserTooling({ ...context, config: parsePipelineConfig({}).config })).toEqual([]);
	});
});
