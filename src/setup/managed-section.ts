// Managed sections: a block of text Kanban owns inside a file that is otherwise the user's (a project's AGENTS.md,
// ~/.claude/CLAUDE.md). Only the text between the two markers is ever rewritten; everything outside stays as it is.
//
//   <!-- kanban:managed begin <id> (written by Kanban: <how to update>) -->
//   …
//   <!-- kanban:managed end <id> -->
//
// The legacy kit wrote `<!-- kanban-kit:begin <id> … -->` / `<!-- kanban-kit:end <id> -->`. Those are read for one
// release: their section reports as `legacy`, and writing it replaces the old markers with the new ones.
// Ported from archive/devteam-kit:bin/kit@d2fb30f (`SECTIONS`, `sectionStatus`, `kit sync`).
import { readFile, writeFile } from "node:fs/promises";

export type ManagedSectionState = "missing-file" | "no-markers" | "current" | "outdated" | "legacy";

export interface ManagedSectionStatus {
	state: ManagedSectionState;
	filePath: string;
	/** The body the section should have (ends with one newline). */
	wanted: string;
	/** The file's text, when it exists. */
	text: string | null;
	/** Offsets of the whole block (markers included) when the file has one. */
	block: { start: number; end: number } | null;
}

export interface ManagedSectionSpec {
	id: string;
	/** Shown in the begin marker, e.g. "kanban project sync". */
	updateHint: string;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function formatManagedSectionBlock(spec: ManagedSectionSpec, body: string): string {
	return `<!-- kanban:managed begin ${spec.id} (written by Kanban: edit outside the markers; ${spec.updateHint} rewrites this part) -->\n${normalizeBody(body)}<!-- kanban:managed end ${spec.id} -->\n`;
}

function normalizeBody(body: string): string {
	return `${body.trimEnd()}\n`;
}

interface FoundBlock {
	start: number;
	bodyStart: number;
	bodyEnd: number;
	end: number;
	legacy: boolean;
}

function findBlock(text: string, id: string): FoundBlock | null {
	const markers = [
		{
			begin: new RegExp(`<!-- kanban:managed begin ${escapeRegExp(id)}\\b[^>]*-->\\n?`, "u"),
			end: `<!-- kanban:managed end ${id} -->`,
			legacy: false,
		},
		{
			begin: new RegExp(`<!-- kanban-kit:begin ${escapeRegExp(id)}\\b[^>]*-->\\n?`, "u"),
			end: `<!-- kanban-kit:end ${id} -->`,
			legacy: true,
		},
	];
	for (const marker of markers) {
		const begin = marker.begin.exec(text);
		if (!begin) {
			continue;
		}
		const bodyStart = begin.index + begin[0].length;
		const bodyEnd = text.indexOf(marker.end, bodyStart);
		if (bodyEnd < 0) {
			continue;
		}
		let end = bodyEnd + marker.end.length;
		if (text[end] === "\n") {
			end += 1;
		}
		return { start: begin.index, bodyStart, bodyEnd, end, legacy: marker.legacy };
	}
	return null;
}

export function getManagedSectionStatusFromText(
	spec: ManagedSectionSpec,
	filePath: string,
	text: string | null,
	body: string,
): ManagedSectionStatus {
	const wanted = normalizeBody(body);
	if (text === null) {
		return { state: "missing-file", filePath, wanted, text, block: null };
	}
	const found = findBlock(text, spec.id);
	if (!found) {
		return { state: "no-markers", filePath, wanted, text, block: null };
	}
	const block = { start: found.start, end: found.end };
	if (found.legacy) {
		return { state: "legacy", filePath, wanted, text, block };
	}
	const current = text.slice(found.bodyStart, found.bodyEnd);
	return { state: current === wanted ? "current" : "outdated", filePath, wanted, text, block };
}

export async function readManagedSectionStatus(
	spec: ManagedSectionSpec,
	filePath: string,
	body: string,
): Promise<ManagedSectionStatus> {
	let text: string | null;
	try {
		text = await readFile(filePath, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			text = null;
		} else {
			throw error;
		}
	}
	return getManagedSectionStatusFromText(spec, filePath, text, body);
}

/**
 * The file text with the section written: an existing block (new or legacy markers) is replaced in place,
 * otherwise the block is appended after one blank line. Returns null when nothing would change.
 */
export function renderManagedSection(spec: ManagedSectionSpec, status: ManagedSectionStatus): string | null {
	if (status.state === "current") {
		return null;
	}
	const block = formatManagedSectionBlock(spec, status.wanted);
	const text = status.text ?? "";
	if (status.block) {
		return `${text.slice(0, status.block.start)}${block}${text.slice(status.block.end)}`;
	}
	const separator = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
	return `${text}${separator}${block}`;
}

export async function writeManagedSection(spec: ManagedSectionSpec, status: ManagedSectionStatus): Promise<boolean> {
	const next = renderManagedSection(spec, status);
	if (next === null) {
		return false;
	}
	await writeFile(status.filePath, next);
	return true;
}
