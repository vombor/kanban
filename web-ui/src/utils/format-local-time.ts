// Every time Kanban itself shows on a card (its pipeline stage, its tooltips) goes through here, so the board reads the
// same way everywhere and always in the viewer's own time zone and locale. Instants travel as data (epoch ms) from the
// runtime; only agent-written text (terminal output, final messages, prompts) is shown as written.

export interface LocalTimeFormatOptions {
	/** The instant "today" is judged against (default: now). */
	now?: number;
	/** Default: the browser's locale. Tests pin it. */
	locale?: string;
	/** Default: the browser's time zone. Tests pin it. */
	timeZone?: string;
}

function readDayParts(at: number, options: LocalTimeFormatOptions): { year: string; day: string } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: options.timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(at);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
	return { year: part("year"), day: `${part("year")}-${part("month")}-${part("day")}` };
}

/**
 * An instant in the viewer's time zone: the short time ("07:03", or "7:03 AM" where the locale uses 12 hours) when it
 * is today there, else the date and time ("Oct 12, 07:03"), with the year when it is another year.
 */
export function formatLocalTime(at: number, options: LocalTimeFormatOptions = {}): string {
	const date = readDayParts(at, options);
	const today = readDayParts(options.now ?? Date.now(), options);
	const sameDay = date.day === today.day;
	return new Intl.DateTimeFormat(options.locale, {
		timeZone: options.timeZone,
		hour: "2-digit",
		minute: "2-digit",
		...(sameDay ? {} : { month: "short", day: "numeric" }),
		...(date.year === today.year ? {} : { year: "numeric" }),
	}).format(at);
}

/** A runtime text with its instants (each one's exact `text` there and the instant) shown in the viewer's time zone. */
export function formatTextTimes(
	text: string,
	times: ReadonlyArray<{ text: string; at: number }>,
	options: LocalTimeFormatOptions = {},
): string {
	return times.reduce((result, time) => result.split(time.text).join(formatLocalTime(time.at, options)), text);
}
