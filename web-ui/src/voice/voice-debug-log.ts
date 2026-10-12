// The voice chat's event log (docs/fork/voice-chat.md, "Diagnostic log"): what the browser's recognizer and speech
// synthesizer really did, with timestamps. The fakes the tests use have twice not matched a real phone, so the log
// records always (a small ring buffer in memory, nothing leaves the page) and the panel only shows it once the user
// turns it on, which also shows what happened before.

export const VOICE_DEBUG_LOG_LIMIT = 120;
const DETAIL_MAX_CHARS = 80;
const VOICE_DEBUG_QUERY_PARAM = "voiceDebug";

export interface VoiceDebugEntry {
	at: number;
	/** The recognition session it belongs to (1, 2, ...), null for page and speech-out entries. */
	session: number | null;
	event: string;
	detail: string | null;
}

let entries: VoiceDebugEntry[] = [];
const listeners = new Set<() => void>();
let environmentLogged = false;

function emit(): void {
	for (const listener of listeners) {
		listener();
	}
}

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > DETAIL_MAX_CHARS ? `${flat.slice(0, DETAIL_MAX_CHARS)}…` : flat;
}

function isStandaloneWebApp(): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
	return iosStandalone || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

// Once per page, before its first entry: which browser, and whether it runs as a home-screen web app.
function logEnvironment(): void {
	if (environmentLogged || typeof navigator === "undefined") {
		return;
	}
	environmentLogged = true;
	entries.push({
		at: Date.now(),
		session: null,
		event: "page",
		detail: `${isStandaloneWebApp() ? "standalone web app" : "browser tab"}; lang ${navigator.language}; ${navigator.userAgent}`,
	});
}

export function logVoiceEvent(event: string, detail: string | null = null, session: number | null = null): void {
	logEnvironment();
	entries = [...entries, { at: Date.now(), session, event, detail: detail === null ? null : clip(detail) }].slice(
		-VOICE_DEBUG_LOG_LIMIT,
	);
	emit();
}

export function clearVoiceDebugLog(): void {
	entries = [];
	environmentLogged = false;
	emit();
}

export function getVoiceDebugEntries(): VoiceDebugEntry[] {
	return entries;
}

export function subscribeVoiceDebugLog(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function formatClock(at: number): string {
	const date = new Date(at);
	const pad = (value: number, length = 2) => String(value).padStart(length, "0");
	return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

/** One line per entry: UTC time, session, event, detail (what the panel shows and Copy copies). */
export function formatVoiceDebugEntry(entry: VoiceDebugEntry): string {
	const session = entry.session === null ? "" : ` #${entry.session}`;
	return `${formatClock(entry.at)}Z${session} ${entry.event}${entry.detail ? ` ${entry.detail}` : ""}`;
}

export function formatVoiceDebugLog(list: VoiceDebugEntry[] = entries): string {
	return list.map(formatVoiceDebugEntry).join("\n");
}

/** `?voiceDebug=1` turns the panel on and `?voiceDebug=0` off; null when the URL says nothing. */
export function readVoiceDebugQuery(search: string): boolean | null {
	const value = new URLSearchParams(search).get(VOICE_DEBUG_QUERY_PARAM);
	if (value === null) {
		return null;
	}
	return value !== "0" && value !== "false";
}
