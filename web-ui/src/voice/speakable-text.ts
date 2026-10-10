// Turns an agent's final message (markdown, which hook ingest has already joined into one line) into text worth
// hearing: code is not read out, markup characters and URLs are dropped, and a long reply is cut.

export const MAX_SPOKEN_CHARS = 1200;
const CODE_BLOCK_NOTE = " (code block) ";
const TRUNCATED_NOTE = " The rest is in the terminal.";

export function toSpeakableText(markdown: string, maxChars = MAX_SPOKEN_CHARS): string {
	const text = markdown
		// Fenced code blocks, closed or cut off at the end.
		.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, CODE_BLOCK_NOTE)
		// Images keep their alt text, links their label.
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<(https?:\/\/[^>]+)>/g, "link")
		.replace(/\bhttps?:\/\/\S+/g, "link")
		// Inline code keeps its text.
		.replace(/`([^`]*)`/g, "$1")
		.replace(/<\/?[a-z][^>]*>/gi, " ")
		// Headings, quotes, bullets and table pipes, at a line start or after the joined line breaks. A "-" bullet
		// inside the line reads as a pause, and numbered items read fine as they are.
		.replace(/(^|\s)#{1,6}\s+/g, "$1")
		.replace(/(^|\s)>\s+/g, "$1")
		.replace(/(^|\s)[*+]\s+(?=\S)/g, "$1")
		.replace(/^\s*-\s+/, "")
		.replace(/\|?\s*:?-{3,}:?\s*(?=\||$)/g, " ")
		.replace(/\s*\|\s*/g, ", ")
		.replace(/(?:,\s*){2,}/g, ", ")
		// Emphasis and strikethrough markers.
		.replace(/(\*{1,3}|_{2,3}|~~)(\S(?:.*?\S)?)\1/g, "$2")
		.replace(/(^|\s)_(\S(?:.*?\S)?)_(?=\s|[.,!?;:]|$)/g, "$1$2")
		.replace(/\s+/g, " ")
		.replace(/\s+([.,!?;:])/g, "$1")
		.replace(/^[,\s]+|[,\s]+$/g, "")
		.trim();
	if (text.length <= maxChars) {
		return text;
	}
	const cut = text.slice(0, maxChars);
	const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
	const kept = sentenceEnd > maxChars / 2 ? cut.slice(0, sentenceEnd + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
	return `${kept}${TRUNCATED_NOTE}`;
}
