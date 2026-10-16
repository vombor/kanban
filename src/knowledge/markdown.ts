import GithubSlugger from "github-slugger";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as markdownText } from "mdast-util-to-string";
import type { KnowledgeSection } from "../trpc/knowledge-contract";
import { KnowledgeError } from "./knowledge-error";

export function describeKnowledgeMarkdown(markdown: string): { sections: KnowledgeSection[]; text: string } {
	const root = fromMarkdown(markdown);
	const slugger = new GithubSlugger();
	const headings = root.children.filter((node) => node.type === "heading");
	if (headings.length > 128)
		throw new KnowledgeError(
			"BAD_REQUEST",
			"A knowledge document can have at most 128 headings; split it into smaller documents.",
		);
	const sections = headings.map((heading, index): KnowledgeSection => {
		const title = markdownText(heading, { includeHtml: false });
		const next = headings.slice(index + 1).find((candidate) => candidate.depth <= heading.depth);
		const id = slugger.slug(title) || slugger.slug(`section-${index + 1}`);
		return {
			id,
			title: title.slice(0, 200),
			depth: heading.depth,
			start: heading.position?.start.offset ?? 0,
			end: next?.position?.start.offset ?? markdown.length,
		};
	});
	if (sections.some((section) => section.id.length > 256))
		throw new KnowledgeError("BAD_REQUEST", "A section identifier is too long; shorten the heading.");
	return { sections, text: markdownText(root, { includeHtml: false }) };
}

/** Continuations use UTF-16 offsets, without splitting a surrogate pair in returned text. */
export function sliceKnowledgeText(text: string, offset: number, limit: number) {
	let start = Math.min(offset, text.length);
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(start))) start += 1;
	let end = Math.min(start + limit, text.length);
	if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end -= 1;
	if (end === start && start < text.length) end = Math.min(start + 2, text.length);
	return {
		markdown: text.slice(start, end),
		offset: start,
		nextOffset: end < text.length ? end : null,
		truncated: end < text.length,
	};
}
