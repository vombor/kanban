import { useEffect } from "react";

// Puts a dot on the tab's favicon while `active` (a project's orchestrator waits for the user, issue #10), so a
// background tab shows it next to the "(n) Kanban" title. The dot is drawn into the app icon's own SVG; without the
// icon (an offline fetch) it is the dot alone, never a broken image.
const FAVICON_SELECTOR = 'link[rel="icon"]';
const APP_ICON_PATH = "/assets/icon.svg";
const BADGE_DOT_SVG = '<circle cx="50" cy="14" r="13" fill="#F85149" stroke="#1F2428" stroke-width="4"/>';

let badgedIconHref: Promise<string> | null = null;

export function buildBadgedFaviconSvg(iconSvg: string): string {
	const closing = iconSvg.lastIndexOf("</svg>");
	if (closing === -1) {
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${BADGE_DOT_SVG}</svg>`;
	}
	return `${iconSvg.slice(0, closing)}${BADGE_DOT_SVG}${iconSvg.slice(closing)}`;
}

function toSvgDataUrl(svg: string): string {
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function loadBadgedIconHref(): Promise<string> {
	badgedIconHref ??= fetch(APP_ICON_PATH)
		.then(async (response) => (response.ok ? await response.text() : ""))
		.catch(() => "")
		.then((iconSvg) => toSvgDataUrl(buildBadgedFaviconSvg(iconSvg)));
	return await badgedIconHref;
}

export function useFaviconBadge(active: boolean): void {
	useEffect(() => {
		const link = typeof document === "undefined" ? null : document.querySelector<HTMLLinkElement>(FAVICON_SELECTOR);
		if (!active || !link) {
			return undefined;
		}
		const originalHref = link.getAttribute("href");
		let cancelled = false;
		void loadBadgedIconHref().then((href) => {
			if (!cancelled) {
				link.setAttribute("href", href);
			}
		});
		return () => {
			cancelled = true;
			if (originalHref !== null) {
				link.setAttribute("href", originalHref);
			}
		};
	}, [active]);
}
