// `kanban qa shot`: headless-browser screenshots for QA agents, the fallback when a project's own screenshot
// tooling fails. QA agents run it in their scratch copy; it is the one kanban command the QA prompt allows.
//
// Routes are shot at each viewport (`<out>/<route>-<viewport>.png`); scripts (JSON step lists) drive the app and
// screenshot along the way. It writes `<out>/report.txt` (one block per page or script: status, console errors,
// failed requests, a page outline) and `<out>/report.json`. Exit 0 even when the page has errors (read the report),
// 3 when the browser can't launch.
//
// Playwright is not a Kanban dependency: it is resolved from the scratch copy (root node_modules, then
// tools/preview). If its bundled browser is missing, the newest chromium_headless_shell in the Playwright cache
// is used. Containers without Chromium's system libraries can point `pipeline.qa.chromiumLibs` (or
// QA_CHROMIUM_LIBS) at an unpacked copy: `<dir>/root/usr/lib/x86_64-linux-gnu` goes on LD_LIBRARY_PATH and
// `<dir>/fonts.conf` becomes FONTCONFIG_FILE.
//
// Ported from archive/devteam-kit:qa/qa-shot.cjs@6da71597.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// The parts of Playwright's API this uses (Playwright is loaded at run time from the project, see above).
interface ShotConsoleMessage {
	type(): string;
	text(): string;
}
interface ShotRequest {
	method(): string;
	url(): string;
	failure(): { errorText: string } | null;
}
interface ShotResponse {
	status(): number;
	request(): ShotRequest;
}
interface ShotLocator {
	first(): ShotLocator;
	waitFor(options: { timeout: number }): Promise<void>;
}
interface ShotPage {
	on(event: "console", listener: (message: ShotConsoleMessage) => void): void;
	on(event: "pageerror", listener: (error: Error) => void): void;
	on(event: "requestfailed", listener: (request: ShotRequest) => void): void;
	on(event: "response", listener: (response: ShotResponse) => void): void;
	goto(url: string, options: { waitUntil: "networkidle" | "load"; timeout: number }): Promise<ShotResponse | null>;
	waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
	title(): Promise<string>;
	url(): string;
	evaluate<T>(expression: string): Promise<T>;
	screenshot(options: { path: string; fullPage: boolean; clip?: ShotClip }): Promise<unknown>;
	fill(selector: string, value: string, options: { timeout: number }): Promise<void>;
	click(selector: string, options: { timeout: number }): Promise<void>;
	press(selector: string, key: string, options: { timeout: number }): Promise<void>;
	selectOption(selector: string, value: string, options: { timeout: number }): Promise<unknown>;
	waitForTimeout(ms: number): Promise<void>;
	getByText(text: string): ShotLocator;
}
interface ShotContext {
	newPage(): Promise<ShotPage>;
	close(): Promise<void>;
}
interface ShotBrowser {
	newContext(options: { viewport: Viewport }): Promise<ShotContext>;
	close(): Promise<void>;
}
interface ShotPlaywright {
	chromium: { launch(options: { env?: NodeJS.ProcessEnv; executablePath?: string }): Promise<ShotBrowser> };
}

interface Viewport {
	width: number;
	height: number;
}

export interface ShotClip {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface QaShotStep {
	type: string;
	url?: string;
	selector?: string;
	value?: string | number;
	key?: string;
	text?: string;
	ms?: number;
	path?: string;
	fullPage?: boolean;
	timeout?: number;
}

export interface QaShotOptions {
	base: string;
	out: string;
	scratch: string;
	routes: string[];
	viewports: string[];
	waitFor: string | null;
	fullPage: boolean;
	scripts: string[];
	chromiumLibs: string | null;
}

interface ShotRecord {
	kind: "route" | "script";
	route?: string;
	script?: string;
	viewport: string;
	url: string;
	status?: number | null;
	title?: string;
	error?: string;
	console: string[];
	failed: string[];
	shots: string[];
	/** Full-page captures cut to QA_SHOT_MAX_PX, one line each. */
	cropped?: string[];
	steps?: string[];
	outline?: string[];
}

export interface QaShotSummary {
	consoleErrors: number;
	failedRequests: number;
	httpErrors: string[];
	stepFailures: string[];
	artifacts: string[];
}

const VIEWPORTS: Record<string, Viewport> = {
	mobile: { width: 375, height: 667 },
	tablet: { width: 768, height: 1024 },
	desktop: { width: 1280, height: 720 },
};
/**
 * The longest side of a screenshot, in image pixels. Anthropic/Bedrock reject an image over 8000 px on a side, and the
 * image then stays in the agent's conversation and fails every later request (issue #12: a full-page capture of a
 * long page), so full-page captures are cut to the top of the page.
 */
export const QA_SHOT_MAX_PX = 7_680;
const NAVIGATION_TIMEOUT_MS = 45_000;
const WAIT_FOR_TIMEOUT_MS = 15_000;
const STEP_TIMEOUT_MS = 10_000;

export function resolveViewport(name: string): Viewport {
	const known = VIEWPORTS[name];
	if (known) {
		return known;
	}
	const match = /^(\d+)x(\d+)$/u.exec(name);
	return match ? { width: Number(match[1]), height: Number(match[2]) } : (VIEWPORTS.desktop as Viewport);
}

export function slugifyRoute(route: string): string {
	return (
		route
			.replace(/^\/+/u, "")
			.replace(/[^a-zA-Z0-9]+/gu, "_")
			.replace(/^_|_$/gu, "") || "home"
	);
}

export function resolveShotUrl(base: string, target: string): string {
	if (/^https?:/u.test(target)) {
		return target;
	}
	return base.replace(/\/$/u, "") + (target.startsWith("/") ? target : `/${target}`);
}

export function getChromiumLaunchEnv(chromiumLibs: string | null, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (!chromiumLibs) {
		return env;
	}
	const libs = join(chromiumLibs, "root/usr/lib/x86_64-linux-gnu");
	const fontsConf = join(chromiumLibs, "fonts.conf");
	return {
		...env,
		...(existsSync(libs) ? { LD_LIBRARY_PATH: [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : {}),
		// No system fonts either: text renders blank without it.
		...(existsSync(fontsConf) && !env.FONTCONFIG_FILE ? { FONTCONFIG_FILE: fontsConf } : {}),
	};
}

function loadPlaywright(scratch: string): ShotPlaywright {
	const require = createRequire(join(scratch, "package.json"));
	for (const root of [scratch, join(scratch, "tools/preview")]) {
		for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
			try {
				return require(require.resolve(name, { paths: [root] })) as ShotPlaywright;
			} catch {
				// Try the next one.
			}
		}
	}
	throw new Error(`playwright not found under ${scratch} (run npm ci there first)`);
}

function findCachedHeadlessShell(): string | null {
	const root = join(homedir(), ".cache/ms-playwright");
	const dirs = existsSync(root)
		? readdirSync(root)
				.filter((dir) => dir.startsWith("chromium_headless_shell-"))
				.sort()
				.reverse()
		: [];
	for (const dir of dirs) {
		const executable = join(root, dir, "chrome-headless-shell-linux64/chrome-headless-shell");
		if (existsSync(executable)) {
			return executable;
		}
	}
	return null;
}

/** The clip that keeps a full-page capture within `max` image pixels a side (CSS px; null: it fits as it is). */
export function capShotClip(
	page: { width: number; height: number; scale: number },
	max = QA_SHOT_MAX_PX,
): ShotClip | null {
	const limit = Math.floor(max / Math.max(page.scale, 1));
	if (page.width <= limit && page.height <= limit) {
		return null;
	}
	return { x: 0, y: 0, width: Math.min(page.width, limit), height: Math.min(page.height, limit) };
}

// Runs in the page, so it is a string: Kanban's TypeScript has no DOM types.
const PAGE_SIZE_SCRIPT = `(() => {
	const root = document.documentElement;
	const body = document.body || root;
	return {
		width: Math.max(root.scrollWidth, body.scrollWidth),
		height: Math.max(root.scrollHeight, body.scrollHeight),
		scale: window.devicePixelRatio || 1,
	};
})()`;

async function takeShot(page: ShotPage, file: string, fullPage: boolean, record: ShotRecord): Promise<void> {
	if (!fullPage) {
		await page.screenshot({ path: file, fullPage: false });
		return;
	}
	const size = await page
		.evaluate<{ width: number; height: number; scale: number }>(PAGE_SIZE_SCRIPT)
		.catch(() => null);
	const clip = size ? capShotClip(size) : null;
	await page.screenshot({ path: file, fullPage: true, ...(clip ? { clip } : {}) });
	if (size && clip) {
		record.cropped ??= [];
		record.cropped.push(
			`${file}: the page is ${size.width}x${size.height} px, kept the top ${clip.width}x${clip.height} (models reject images over 8000 px)`,
		);
	}
}

// Runs in the page, so it is a string: Kanban's TypeScript has no DOM types.
const OUTLINE_SCRIPT = `(() => {
	const lines = [];
	const txt = (el) => (el.innerText || el.getAttribute("aria-label") || el.getAttribute("value") || "").trim().replace(/\\s+/g, " ").slice(0, 60);
	const sel = "h1,h2,h3,button,[role=button],a[href],input,select,textarea,nav,main,[role=dialog]";
	for (const el of document.querySelectorAll(sel)) {
		const tag = el.tagName.toLowerCase();
		const hidden = !(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
		if (hidden && !/^h[1-3]$/.test(tag)) continue;
		if (/^h[1-3]$/.test(tag)) lines.push("  ".repeat(+tag[1] - 1) + tag.toUpperCase() + ": " + txt(el));
		else if (tag === "button" || el.getAttribute("role") === "button") lines.push("    [BUTTON] " + txt(el));
		else if (tag === "a") lines.push("    [LINK] " + txt(el) + " -> " + el.getAttribute("href"));
		else if (tag === "nav" || tag === "main") lines.push("  <" + tag + (el.getAttribute("aria-label") ? ' "' + el.getAttribute("aria-label") + '"' : "") + ">");
		else if (el.getAttribute("role") === "dialog") lines.push("  [DIALOG] " + (el.getAttribute("aria-label") || ""));
		else {
			const id = el.id;
			const label = (id && document.querySelector('label[for="' + CSS.escape(id) + '"]')?.innerText) || el.closest("label")?.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
			lines.push("    [" + tag.toUpperCase() + " " + (el.getAttribute("name") || el.type || "") + "] " + (label.trim().slice(0, 40) || "(NO LABEL)"));
		}
		if (lines.length >= 120) { lines.push("    ..."); break; }
	}
	return lines;
})()`;

function oneLine(text: string): string {
	return text.replace(/\s*\n\s*/gu, " ⏎ ").slice(0, 300);
}

function watchPage(page: ShotPage, record: ShotRecord): void {
	page.on("console", (message) => {
		const type = message.type();
		if (type === "error" || type === "warning") {
			record.console.push(`[${type === "warning" ? "warn" : "error"}] ${oneLine(message.text())}`);
		}
	});
	page.on("pageerror", (error) =>
		record.console.push(`[error] pageerror: ${oneLine(String(error.message || error))}`),
	);
	page.on("requestfailed", (request) =>
		record.failed.push(`${request.method()} ${request.url()} -> ${request.failure()?.errorText || "failed"}`),
	);
	page.on("response", (response) => {
		if (response.status() >= 400) {
			record.failed.push(`${response.request().method()} ${response.request().url()} -> ${response.status()}`);
		}
	});
}

export function formatShotBlock(record: ShotRecord): string {
	const rule = "=".repeat(60);
	const lines = [
		rule,
		`${record.kind === "script" ? "BROWSE SCRIPT" : "SCREENSHOT REPORT"}${record.viewport ? ` (${record.viewport})` : ""}`,
		rule,
	];
	lines.push(`URL:      ${record.url}`, `Status:   ${record.status ?? "n/a"}`, `Title:    ${record.title ?? ""}`);
	if (record.error) {
		lines.push(`ERROR:    ${record.error}`);
	}
	if (record.steps) {
		lines.push(rule, "STEPS:", ...record.steps.map((step) => `  ${step}`));
	}
	lines.push(rule, "CONSOLE:", ...(record.console.length ? record.console.map((line) => `  ${line}`) : ["  (none)"]));
	lines.push(
		rule,
		"FAILED REQUESTS:",
		...(record.failed.length ? record.failed.map((line) => `  ${line}`) : ["  (none)"]),
	);
	lines.push(rule, "PAGE OUTLINE:", ...(record.outline?.length ? record.outline : ["  (empty)"]));
	lines.push(
		rule,
		...record.shots.map((shot) => `Screenshot saved: ${shot}`),
		...(record.cropped ?? []).map((line) => `Screenshot cropped: ${line}`),
		"",
	);
	return lines.join("\n");
}

function firstLine(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

async function navigate(page: ShotPage, url: string, record: ShotRecord, waitFor: string | null): Promise<void> {
	let response: ShotResponse | null;
	try {
		response = await page.goto(url, { waitUntil: "networkidle", timeout: NAVIGATION_TIMEOUT_MS });
	} catch {
		// HMR/SSE keep the network busy.
		response = await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
	}
	record.status = response?.status() ?? null;
	if (waitFor) {
		await page
			.waitForSelector(waitFor, { timeout: WAIT_FOR_TIMEOUT_MS })
			.catch(() => record.console.push(`[error] qa shot: --wait-for ${waitFor} not found`));
	}
}

async function runStep(page: ShotPage, step: QaShotStep, record: ShotRecord, options: QaShotOptions): Promise<void> {
	const timeout = step.timeout ?? STEP_TIMEOUT_MS;
	const selector = step.selector ?? "";
	switch (step.type) {
		case "goto":
			await navigate(page, resolveShotUrl(options.base, step.url ?? "/"), record, options.waitFor);
			return;
		case "fill":
			await page.fill(selector, String(step.value ?? ""), { timeout });
			return;
		case "click":
			await page.click(selector, { timeout });
			return;
		case "press":
			await page.press(selector, step.key ?? "Enter", { timeout });
			return;
		case "select":
			await page.selectOption(selector, String(step.value ?? ""), { timeout });
			return;
		case "waitFor":
			await page.waitForSelector(selector, { timeout });
			return;
		case "wait":
			await page.waitForTimeout(step.ms ?? 1000);
			return;
		case "expectText":
			await page
				.getByText(step.text ?? "")
				.first()
				.waitFor({ timeout });
			return;
		case "screenshot": {
			const target = step.path ?? `step-${record.shots.length + 1}.png`;
			const file = isAbsolute(target) ? target : join(options.out, target);
			mkdirSync(dirname(file), { recursive: true });
			await takeShot(page, file, step.fullPage ?? options.fullPage, record);
			record.shots.push(file);
			return;
		}
		default:
			throw new Error(`unknown step type ${step.type}`);
	}
}

function readScript(path: string): { viewport: string; steps: QaShotStep[] } {
	const spec = JSON.parse(readFileSync(path, "utf8")) as QaShotStep[] | { viewport?: string; steps?: QaShotStep[] };
	return Array.isArray(spec)
		? { viewport: "desktop", steps: spec }
		: { viewport: spec.viewport || "desktop", steps: spec.steps ?? [] };
}

export async function runQaShot(options: QaShotOptions): Promise<{ exitCode: number; message: string }> {
	const out = resolve(options.out);
	const scratch = resolve(options.scratch);
	mkdirSync(out, { recursive: true });
	let browser: ShotBrowser;
	try {
		const playwright = loadPlaywright(scratch);
		const env = getChromiumLaunchEnv(options.chromiumLibs, process.env);
		try {
			browser = await playwright.chromium.launch({ env });
		} catch (error) {
			const executablePath = findCachedHeadlessShell();
			if (!executablePath) {
				throw error;
			}
			browser = await playwright.chromium.launch({ executablePath, env });
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeFileSync(join(out, "report.txt"), `BROWSER LAUNCH FAILED: ${message}\n`);
		return { exitCode: 3, message: `qa shot: browser launch failed: ${firstLine(error)}` };
	}
	const records: ShotRecord[] = [];
	for (const route of options.routes) {
		for (const viewport of options.viewports) {
			const record: ShotRecord = {
				kind: "route",
				route,
				viewport,
				url: resolveShotUrl(options.base, route),
				console: [],
				failed: [],
				shots: [],
			};
			const context = await browser.newContext({ viewport: resolveViewport(viewport) });
			const page = await context.newPage();
			watchPage(page, record);
			try {
				await navigate(page, record.url, record, options.waitFor);
				record.title = await page.title();
				record.outline = await page.evaluate<string[]>(OUTLINE_SCRIPT);
				const file = join(out, `${slugifyRoute(route)}-${viewport}.png`);
				await takeShot(page, file, options.fullPage, record);
				record.shots.push(file);
			} catch (error) {
				record.error = firstLine(error);
			}
			await context.close();
			records.push(record);
		}
	}
	for (const script of options.scripts) {
		const { viewport, steps } = readScript(script);
		const record: ShotRecord = {
			kind: "script",
			script,
			viewport,
			url: options.base,
			console: [],
			failed: [],
			shots: [],
			steps: [],
		};
		const context = await browser.newContext({ viewport: resolveViewport(viewport) });
		const page = await context.newPage();
		watchPage(page, record);
		for (const step of steps) {
			const label = `${step.type} ${step.selector || step.url || step.path || step.text || step.ms || ""}`.trim();
			try {
				await runStep(page, step, record, { ...options, out });
				record.steps?.push(`ok   ${label}`);
			} catch (error) {
				record.steps?.push(`FAIL ${label}: ${firstLine(error).slice(0, 200)}`);
				const file = join(out, `${slugifyRoute(basename(script, ".json"))}-failure.png`);
				await takeShot(page, file, true, record).catch(() => {});
				record.shots.push(file);
				record.error = `step failed: ${label}`;
				break;
			}
		}
		record.url = page.url();
		record.title = await page.title().catch(() => "");
		record.outline = await page.evaluate<string[]>(OUTLINE_SCRIPT).catch(() => []);
		await context.close();
		records.push(record);
	}
	await browser.close();
	writeFileSync(join(out, "report.txt"), records.map(formatShotBlock).join("\n"));
	const summary: QaShotSummary & { pages: unknown[] } = {
		consoleErrors: records.flatMap((record) => record.console.filter((line) => line.startsWith("[error]"))).length,
		failedRequests: records.reduce((count, record) => count + record.failed.length, 0),
		httpErrors: records
			.filter((record) => record.status && record.status >= 400)
			.map((record) => `${record.url} ${record.status}`),
		stepFailures: records
			.filter((record) => record.error)
			.map((record) => `${record.script || record.route} (${record.viewport}): ${record.error}`),
		artifacts: [join(out, "report.txt"), ...records.flatMap((record) => record.shots)],
		pages: records.map(({ kind, route, script, viewport, url, status, title, console, failed, error }) => ({
			kind,
			route,
			script,
			viewport,
			url,
			status,
			title,
			console,
			failed,
			error,
		})),
	};
	writeFileSync(join(out, "report.json"), JSON.stringify(summary, null, 2));
	return {
		exitCode: 0,
		message: `qa shot: ${records.length} page(s)/script(s), ${summary.artifacts.length - 1} png, consoleErrors=${summary.consoleErrors}, failedRequests=${summary.failedRequests}, httpErrors=${summary.httpErrors.length}, stepFailures=${summary.stepFailures.length} -> ${out}/report.txt`,
	};
}
