import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renameDurably, syncDirectory, writeFileSynced } from "../../src/fs/durable-file";
import { createTempDir } from "../utilities/temp-dir";

describe("durable file writes (issue #36)", () => {
	const temps: Array<{ cleanup: () => void }> = [];
	afterEach(() => {
		for (const temp of temps.splice(0)) {
			temp.cleanup();
		}
	});

	it("writes a synced temp file with its mode and renames it over the target", async () => {
		const temp = createTempDir("kanban-durable-");
		temps.push(temp);
		const dir = join(temp.path, "data");
		mkdirSync(dir);
		const target = join(dir, "state.json");
		await writeFileSynced(`${target}.tmp`, "{}", { encoding: "utf8", mode: 0o600 });
		expect(statSync(`${target}.tmp`).mode & 0o777).toBe(0o600);
		await renameDurably(`${target}.tmp`, target);
		expect(readFileSync(target, "utf8")).toBe("{}");
		expect(readdirSync(dir)).toEqual(["state.json"]);
		await expect(writeFileSynced(target, "again", { flag: "wx" })).rejects.toThrow(/EEXIST/u);
		await expect(syncDirectory(dir)).resolves.toBeUndefined();
	});
});
