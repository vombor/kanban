import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMINAL_HISTORY_PAGE_BYTES, TERMINAL_HISTORY_PAGE_LINES } from "../../../src/core/terminal-history";
import { appendTerminalOutput, readTerminalOutputPage } from "../../../src/terminal/terminal-output-archive";

describe("private terminal archive / bounded readback (#65)", () => {
	it("reports recording trouble without throwing into the agent output callback", () => {
		const home = mkdtempSync(join(tmpdir(), "kanban-output-error-"));
		mkdirSync(join(home, "data"));
		writeFileSync(join(home, "data/project"), "not a directory");
		expect(() =>
			appendTerminalOutput("project", "task", Buffer.from("do not lose the agent"), home, () => {
				throw new Error("logger also failed");
			}),
		).not.toThrow();
	});
	it("keeps complete output across runs while reading only a recent bounded page", async () => {
		const home = mkdtempSync(join(tmpdir(), "kanban-output-archive-"));
		const content = Array.from({ length: 20000 }, (_, i) => `line-${i}: \u001b[31mhello🙂\u001b[0m`).join("\r\n");
		const bytes = Buffer.from(content);
		appendTerminalOutput("project", "task", bytes.subarray(0, 100000), home);
		appendTerminalOutput("project", "task", bytes.subarray(100000), home);
		const page = await readTerminalOutputPage("project", { taskId: "task" }, home);
		expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(TERMINAL_HISTORY_PAGE_BYTES);
		expect(page.text.split("\n").length).toBeLessThanOrEqual(TERMINAL_HISTORY_PAGE_LINES + 1);
		expect(page.text).toContain("line-19999");
		expect(page.text).not.toContain("line-0:");
		const older = await readTerminalOutputPage("project", { taskId: "task", end: page.start }, home);
		expect(older.end).toBe(page.start);
		expect(older.start).toBeLessThan(page.start);
		const dir = join(home, "data/project/terminal-output");
		const path = join(dir, readdirSync(dir)[0] ?? "missing");
		expect(readFileSync(path, "utf8")).toBe(content);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
	it("bounds long lines, aligns UTF-8 page boundaries and scopes filenames by workspace/task", async () => {
		const home = mkdtempSync(join(tmpdir(), "kanban-output-pages-"));
		const text = `${"🙂".repeat(40000)}END`;
		appendTerminalOutput("a", "../unsafe/task", Buffer.from(text), home);
		const newest = await readTerminalOutputPage("a", { taskId: "../unsafe/task" }, home);
		const older = await readTerminalOutputPage("a", { taskId: "../unsafe/task", end: newest.start }, home);
		expect(newest.text).not.toContain("�");
		expect(older.text).not.toContain("�");
		expect((await readTerminalOutputPage("b", { taskId: "../unsafe/task" }, home)).available).toBe(false);
		expect(readdirSync(join(home, "data/a/terminal-output"))[0]).toMatch(/^[a-f0-9]{64}\.log$/u);
	});
});
