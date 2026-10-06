export interface InlineSuffixClampOptions {
	maxWidthPx: number;
	maxLines: number;
	suffix: string;
	measureText: (value: string) => number;
	/** When set, results are memoized per (cacheKey, width, lines, suffix, text). Use it to encode the font. */
	cacheKey?: string;
}

export interface InlineSuffixClampResult {
	text: string;
	isTruncated: boolean;
}

export const DEFAULT_TASK_PROMPT_LABEL_MAX_CHARS = 100;

export function normalizePromptForDisplay(prompt: string): string {
	return prompt.replaceAll(/\s+/g, " ").trim();
}

function stripOuterXmlTag(text: string): string {
	return text
		.replace(/^<[^>]+>/u, "")
		.replace(/<\/[^>]+>$/u, "")
		.trim();
}

export function getTaskPromptDescription(prompt: string, title: string): string {
	const normalizedPrompt = stripOuterXmlTag(normalizePromptForDisplay(prompt));
	const normalizedTitle = normalizePromptForDisplay(title);
	if (!normalizedPrompt) {
		return "";
	}
	if (!normalizedTitle) {
		return normalizedPrompt;
	}
	if (normalizedPrompt === normalizedTitle) {
		return "";
	}
	if (normalizedPrompt.startsWith(normalizedTitle)) {
		const remainder = normalizedPrompt
			.slice(normalizedTitle.length)
			.replace(/^[\s:;,.!?-]+/u, "")
			.trim();
		if (remainder.length > 0) {
			return remainder;
		}
	}
	return normalizedPrompt;
}

interface WrapResult {
	lines: string[];
	/** Index in the normalized text where wrapping stopped (text length when every line was wrapped). */
	endIndex: number;
}

// Wraps greedily by measured width. With maxLines it stops after that many lines, so a long prompt only
// costs the lines that can be shown. Each line is found by an exponential probe followed by a binary
// search inside the probed window, so the measured slices stay about one line long instead of spanning
// the rest of the text (a 6 KB prompt used to cost millions of measured characters per card).
function wrapTextByWidth(
	text: string,
	options: Pick<InlineSuffixClampOptions, "maxWidthPx" | "measureText">,
	maxLines = Number.POSITIVE_INFINITY,
): WrapResult {
	const normalizedText = normalizePromptForDisplay(text);
	if (!normalizedText) {
		return { lines: [], endIndex: 0 };
	}
	const maxWidth = Math.max(0, options.maxWidthPx);
	if (maxWidth <= 0) {
		return { lines: [normalizedText], endIndex: normalizedText.length };
	}

	const lines: string[] = [];
	let startIndex = 0;

	while (startIndex < normalizedText.length && lines.length < maxLines) {
		let probe = 32;
		let low = startIndex + 1;
		let high = Math.min(normalizedText.length, startIndex + probe);
		while (high < normalizedText.length && options.measureText(normalizedText.slice(startIndex, high)) <= maxWidth) {
			low = high;
			probe *= 2;
			high = Math.min(normalizedText.length, startIndex + probe);
		}
		let fitIndex = low;

		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const candidate = normalizedText.slice(startIndex, middle);
			if (options.measureText(candidate) <= maxWidth) {
				fitIndex = middle;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}

		let endIndex = fitIndex;
		if (endIndex < normalizedText.length) {
			const lastSpaceIndex = normalizedText.lastIndexOf(" ", endIndex - 1);
			if (lastSpaceIndex >= startIndex) {
				endIndex = lastSpaceIndex;
			}
		}

		const line = normalizedText.slice(startIndex, endIndex).trim();
		if (!line) {
			startIndex += 1;
			continue;
		}

		lines.push(line);
		startIndex = endIndex;
		while (normalizedText[startIndex] === " ") {
			startIndex += 1;
		}
	}

	return { lines, endIndex: startIndex };
}

export function truncateTaskPromptLabel(prompt: string, maxChars = DEFAULT_TASK_PROMPT_LABEL_MAX_CHARS): string {
	if (maxChars <= 0) {
		return "";
	}
	const normalized = normalizePromptForDisplay(prompt);
	if (normalized.length <= maxChars) {
		return normalized;
	}
	const truncated = normalized.slice(0, maxChars).trimEnd();
	return `${truncated}…`;
}

const CLAMP_CACHE_LIMIT = 500;
const clampCache = new Map<string, InlineSuffixClampResult>();

function hashText(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${(hash >>> 0).toString(36)}:${text.length}`;
}

export function clampTextWithInlineSuffix(text: string, options: InlineSuffixClampOptions): InlineSuffixClampResult {
	const normalizedText = normalizePromptForDisplay(text);
	if (!normalizedText) {
		return {
			text: "",
			isTruncated: false,
		};
	}

	if (options.maxLines <= 0 || options.maxWidthPx <= 0) {
		return {
			text: normalizedText,
			isTruncated: false,
		};
	}

	const cacheKey =
		options.cacheKey === undefined
			? null
			: `${options.cacheKey}|${options.maxWidthPx}|${options.maxLines}|${options.suffix}|${hashText(normalizedText)}`;
	if (cacheKey) {
		const cached = clampCache.get(cacheKey);
		if (cached) {
			return cached;
		}
	}
	const result = clampUncached(normalizedText, options);
	if (cacheKey) {
		if (clampCache.size >= CLAMP_CACHE_LIMIT) {
			const oldestKey = clampCache.keys().next().value;
			if (oldestKey !== undefined) {
				clampCache.delete(oldestKey);
			}
		}
		clampCache.set(cacheKey, result);
	}
	return result;
}

function clampUncached(normalizedText: string, options: InlineSuffixClampOptions): InlineSuffixClampResult {
	// Only the first maxLines lines can be shown, so nothing past them needs to be measured to decide this.
	const wrapped = wrapTextByWidth(normalizedText, options, options.maxLines);
	if (wrapped.endIndex >= normalizedText.length) {
		return {
			text: normalizedText,
			isTruncated: false,
		};
	}

	// Same search as before over the whole length (wrapping with a suffix is not monotone, so narrowing the
	// range changes results), but each probe stops wrapping after maxLines + 1 lines, so it stays cheap.
	let low = 0;
	let high = normalizedText.length;
	let bestFitIndex = 0;

	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = normalizedText.slice(0, middle).trimEnd();
		const lines = wrapTextByWidth(`${candidate}${options.suffix}`, options, options.maxLines + 1).lines;
		if (lines.length <= options.maxLines) {
			bestFitIndex = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	let truncatedText = normalizedText.slice(0, bestFitIndex).trimEnd();
	if (bestFitIndex < normalizedText.length && normalizedText[bestFitIndex] !== " ") {
		const lastSpaceIndex = truncatedText.lastIndexOf(" ");
		if (lastSpaceIndex > 0) {
			truncatedText = truncatedText.slice(0, lastSpaceIndex).trimEnd();
		}
	}

	return {
		text: truncatedText,
		isTruncated: true,
	};
}
