import { describe, expect, it } from "vitest";

import {
	formatManagedSectionBlock,
	getManagedSectionStatusFromText,
	type ManagedSectionSpec,
	renderManagedSection,
} from "../../../src/setup/managed-section";

const spec: ManagedSectionSpec = { id: "agents-qa", updateHint: "kanban project sync" };

function status(text: string | null, body = "Wanted text.") {
	return getManagedSectionStatusFromText(spec, "/repo/AGENTS.md", text, body);
}

describe("managed sections", () => {
	it("reports missing files, files without markers, current and outdated sections", () => {
		expect(status(null).state).toBe("missing-file");
		expect(status("# Project\n").state).toBe("no-markers");
		const current = `# Project\n\n${formatManagedSectionBlock(spec, "Wanted text.")}`;
		expect(status(current).state).toBe("current");
		expect(status(current, "New text.").state).toBe("outdated");
	});

	it("rewrites only the text between the markers", () => {
		const text = `# Mine\n\n${formatManagedSectionBlock(spec, "Old.")}\n## Also mine\n`;
		const next = renderManagedSection(spec, status(text, "New."));
		expect(next).toBe(`# Mine\n\n${formatManagedSectionBlock(spec, "New.")}\n## Also mine\n`);
		expect(renderManagedSection(spec, status(next, "New."))).toBeNull();
	});

	it("appends after one blank line when the file has no section", () => {
		expect(renderManagedSection(spec, status("# Mine"))).toBe(
			`# Mine\n\n${formatManagedSectionBlock(spec, "Wanted text.")}`,
		);
		expect(renderManagedSection(spec, status("# Mine\n"))).toBe(
			`# Mine\n\n${formatManagedSectionBlock(spec, "Wanted text.")}`,
		);
		expect(renderManagedSection(spec, status(null))).toBe(formatManagedSectionBlock(spec, "Wanted text."));
	});

	it("reads the legacy kit's markers and replaces them with Kanban's", () => {
		const legacy = [
			"# Mine",
			"<!-- kanban-kit:begin agents-qa (managed by ~/.kanban: edit the kit template, then run kit sync) -->",
			"Kit text.",
			"<!-- kanban-kit:end agents-qa -->",
			"tail",
			"",
		].join("\n");
		const read = status(legacy);
		expect(read.state).toBe("legacy");
		const next = renderManagedSection(spec, read);
		expect(next).toBe(`# Mine\n${formatManagedSectionBlock(spec, "Wanted text.")}tail\n`);
		expect(next).not.toContain("kanban-kit:");
	});

	it("ignores a begin marker without its end marker", () => {
		expect(status("<!-- kanban:managed begin agents-qa -->\nno end\n").state).toBe("no-markers");
	});
});
