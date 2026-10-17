// Retained browser bundles are installation assets. Inspect read-only; repair only through the user command.

import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DOMParser, type Document, type Element, onWarningStopParsing, XMLSerializer } from "@xmldom/xmldom";

import { renameDurably, writeFileSynced } from "../fs/durable-file";

export interface QaFontconfigInspection {
	checkedUserId: number | null;
	vendorPath: string;
	configPath: string;
	fontDirectory: string;
	cacheDirectory: string;
	issues: string[];
	fontFilesReadable: boolean;
	cacheWritable: boolean;
}

const EMPTY_FONTCONFIG = '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig/>';
const CACHE_MARKER = "Kanban retained browser font cache";

function parseFontconfig(source: string): Document {
	try {
		const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(source, "application/xml");
		if (document.documentElement?.tagName !== "fontconfig") throw new Error("Wrong root element");
		return document;
	} catch {
		throw new Error("Fontconfig XML is malformed; refusing to replace it. Repair its syntax explicitly first.");
	}
}

function readFontconfig(path: string): Document {
	if (!existsSync(path)) return parseFontconfig(EMPTY_FONTCONFIG);
	if (statSync(path).size > 1024 * 1024) throw new Error("Fontconfig XML exceeds the bounded inspection size");
	return parseFontconfig(readFileSync(path, "utf8"));
}

function accessible(path: string, flags: number): boolean {
	try {
		accessSync(path, flags);
		return true;
	} catch {
		return false;
	}
}

function writableCache(path: string): boolean {
	let parent = path;
	while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
	return accessible(parent, constants.W_OK | constants.X_OK) && statSync(parent).isDirectory();
}

function hasReadableFont(path: string, depth = 0): boolean {
	if (depth > 6 || !accessible(path, constants.R_OK | constants.X_OK)) return false;
	try {
		for (const entry of readdirSync(path, { withFileTypes: true }).slice(0, 4096)) {
			const child = join(path, entry.name);
			if (entry.isDirectory() && hasReadableFont(child, depth + 1)) return true;
			if (entry.isFile() && /\.(?:ttf|otf|ttc)$/iu.test(entry.name) && accessible(child, constants.R_OK))
				return true;
		}
	} catch {
		return false;
	}
	return false;
}

function resolveConfiguredPath(element: Element, configPath: string, env: NodeJS.ProcessEnv): string | null {
	const value = element.textContent?.trim() ?? "";
	if (!value) return null;
	const prefix = element.getAttribute("prefix") || "default";
	if (element.tagName === "cachedir" && prefix !== "default" && prefix !== "xdg") return null;
	const home = env.HOME || homedir();
	if (value.startsWith("~/")) return resolve(home, value.slice(2));
	if (isAbsolute(value)) return resolve(value);
	if (prefix === "relative" && element.tagName === "dir") return resolve(dirname(configPath), value);
	if (prefix === "xdg") {
		const root =
			element.tagName === "cachedir"
				? env.XDG_CACHE_HOME || join(home, ".cache")
				: env.XDG_DATA_HOME || join(home, ".local/share");
		return resolve(root, value);
	}
	return prefix === "default" || prefix === "cwd" ? resolve(value) : null;
}

export function inspectQaFontconfig(vendor: string, env: NodeJS.ProcessEnv = process.env): QaFontconfigInspection {
	const vendorPath = realpathSync(vendor);
	const configPath = join(vendorPath, "fonts.conf");
	const fontDirectory = join(vendorPath, "root/usr/share/fonts");
	const cacheDirectory = join(vendorPath, "fontcache");
	const issues: string[] = [];
	const fontFilesReadable = hasReadableFont(fontDirectory);
	const cacheWritable = writableCache(cacheDirectory);
	if (!fontFilesReadable) issues.push(`No readable retained font files under ${fontDirectory}`);
	if (!cacheWritable) issues.push(`Retained font cache is not writable: ${cacheDirectory}`);
	if (!existsSync(configPath)) issues.push(`Fontconfig file is missing: ${configPath}`);
	const document = readFontconfig(configPath);
	for (const tag of ["dir", "cachedir"]) {
		const elements = document.getElementsByTagName(tag);
		if (!elements.length) issues.push(`Fontconfig has no ${tag} entry`);
		for (let index = 0; index < elements.length; index += 1) {
			const element = elements.item(index);
			if (!element) continue;
			const path = resolveConfiguredPath(element, configPath, env);
			if (!path || (tag === "dir" ? !hasReadableFont(path) : !writableCache(path)))
				issues.push(`Fontconfig ${tag} path is unavailable: ${path ?? "unsupported path prefix"}`);
			if (
				path &&
				ownedPath(element) &&
				(tag === "cachedir"
					? path !== cacheDirectory
					: path !== fontDirectory && !path.startsWith(`${fontDirectory}/`))
			)
				issues.push(`Retained Fontconfig ${tag} still points outside the resolved vendor home: ${path}`);
		}
	}
	return {
		checkedUserId: process.getuid?.() ?? null,
		vendorPath,
		configPath,
		fontDirectory,
		cacheDirectory,
		issues,
		fontFilesReadable,
		cacheWritable,
	};
}

function ownedPath(element: Element): boolean {
	const value = element.textContent?.trim() ?? "";
	let previous = element.previousSibling;
	while (previous?.nodeType === 3 && !previous.nodeValue?.trim()) previous = previous.previousSibling;
	return (
		/(?:^|[/\\])vendor[/\\]chromium-libs[/\\](?:root[/\\]usr[/\\]share[/\\]fonts|fontcache)(?:[/\\]|$)/u.test(
			value,
		) ||
		(previous?.nodeType === 8 && previous.nodeValue === CACHE_MARKER) ||
		(element.tagName === "dir" && element.getAttribute("prefix") === "relative" && value === "root/usr/share/fonts")
	);
}

/** Preserve custom aliases/matches/includes and unrelated dirs; only replace the known retained bundle paths. */
export function buildRelocatedFontconfig(source: string | null, cacheDirectory: string): string {
	const document = parseFontconfig(source ?? EMPTY_FONTCONFIG);
	const root = document.documentElement;
	if (!root) throw new Error("Missing Fontconfig root");
	for (const tag of ["dir", "cachedir"]) {
		const elements = document.getElementsByTagName(tag);
		const owned: Element[] = [];
		for (let index = 0; index < elements.length; index += 1) {
			const element = elements.item(index);
			if (element && (ownedPath(element) || (tag === "cachedir" && element.textContent?.trim() === cacheDirectory)))
				owned.push(element);
		}
		const element = owned.shift() ?? document.createElement(tag);
		for (const duplicate of owned) duplicate.parentNode?.removeChild(duplicate);
		if (!element.parentNode) root.appendChild(element);
		element.textContent = tag === "dir" ? "root/usr/share/fonts" : cacheDirectory;
		if (tag === "dir") element.setAttribute("prefix", "relative");
		else {
			element.removeAttribute("prefix");
			if (element.previousSibling?.nodeValue !== CACHE_MARKER)
				element.parentNode?.insertBefore(document.createComment(CACHE_MARKER), element);
		}
	}
	return `${new XMLSerializer().serializeToString(document).trimEnd()}\n`;
}

export async function repairQaFontconfig(
	vendor: string,
): Promise<QaFontconfigInspection & { backupPath: string | null }> {
	const inspection = inspectQaFontconfig(vendor);
	if (!inspection.fontFilesReadable || !inspection.cacheWritable)
		throw new Error(
			"Retained fonts/cache are not accessible to this user; refusing to rewrite Fontconfig or change ownership.",
		);
	if (existsSync(inspection.configPath) && lstatSync(inspection.configPath).isSymbolicLink())
		throw new Error("Fontconfig is a user symlink; refusing to overwrite it.");
	if (existsSync(inspection.cacheDirectory) && lstatSync(inspection.cacheDirectory).isSymbolicLink())
		throw new Error("Font cache is a user symlink; refusing to write through it.");
	const source = existsSync(inspection.configPath) ? readFileSync(inspection.configPath, "utf8") : null;
	const xml = buildRelocatedFontconfig(source, inspection.cacheDirectory);
	mkdirSync(inspection.cacheDirectory, { recursive: true, mode: 0o700 });
	const backupPath = source === null ? null : `${inspection.configPath}.backup-${randomUUID()}`;
	if (backupPath && source !== null) await writeFileSynced(backupPath, source, { mode: 0o600, flag: "wx" });
	const temporary = `${inspection.configPath}.${randomUUID()}.tmp`;
	await writeFileSynced(temporary, xml, { mode: 0o644, flag: "wx" });
	await renameDurably(temporary, inspection.configPath);
	return { ...inspectQaFontconfig(inspection.vendorPath), backupPath };
}
