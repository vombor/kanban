// Read-only view of the legacy dev-team kit (plan §1: its config `kit.config.json` and its services' pid files), for
// `kanban doctor`'s "one owner" check (§8.2) and `kanban config import-kit` (§3.5). Kanban never writes any of it:
// the legacy kit keeps running until the cutover card switches each of its services off.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
	expandKanbanConfigPath,
	getLegacyKitConfigPath,
	getLegacyKitDefaultRunPath,
	getLegacyKitHomePath,
} from "../state/kanban-home";

export type LegacyKitRaw = Record<string, unknown>;

export interface LegacyKitConfigFile {
	path: string;
	/** The parsed file, or null when it doesn't exist (no legacy kit) or doesn't parse (see `error`). */
	raw: LegacyKitRaw | null;
	error: string | null;
}

export async function readLegacyKitConfig(path: string = getLegacyKitConfigPath()): Promise<LegacyKitConfigFile> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { path, raw: null, error: null };
		}
		return { path, raw: null, error: error instanceof Error ? error.message : String(error) };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { path, raw: null, error: "not a JSON object" };
		}
		return { path, raw: parsed as LegacyKitRaw, error: null };
	} catch (error) {
		return { path, raw: null, error: error instanceof Error ? error.message : String(error) };
	}
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The project toggles that make the legacy kit QA, rework and land a project's cards. */
export const LEGACY_KIT_PROJECT_TOGGLES = ["QA_CREATE", "AUTO_REWORK", "AUTO_DONE"] as const;
export type LegacyKitProjectToggle = (typeof LEGACY_KIT_PROJECT_TOGGLES)[number];

export interface LegacyKitProject {
	workspaceId: string;
	projectPath: string | null;
	raw: Record<string, unknown>;
	/**
	 * On only where the project's own entry says `true`. Since K-1 (legacy kit lib/config.cjs@92101ca, after the
	 * archive cut) a project never inherits them from the top level; before it every project did, which is how
	 * kanban-2uge got foo's QA routing on 2026-10-06 (plan §4.0).
	 */
	toggles: Record<LegacyKitProjectToggle, boolean>;
}

export function listLegacyKitProjects(raw: LegacyKitRaw): LegacyKitProject[] {
	const projects = Array.isArray(raw.projects) ? raw.projects : [];
	return projects.filter(isPlainRecord).flatMap((entry) => {
		if (typeof entry.workspaceId !== "string" || entry.workspaceId.trim() === "") {
			return [];
		}
		const toggles = isPlainRecord(entry.toggles) ? entry.toggles : {};
		return [
			{
				workspaceId: entry.workspaceId,
				projectPath: typeof entry.projectPath === "string" ? entry.projectPath : null,
				raw: entry,
				toggles: Object.fromEntries(
					LEGACY_KIT_PROJECT_TOGGLES.map((name) => [name, toggles[name] === true]),
				) as Record<LegacyKitProjectToggle, boolean>,
			},
		];
	});
}

/**
 * Projects that have a project toggle on only through the top level, which K-1 no longer applies to them (the
 * legacy `kit check` warning). Ported from legacy kit lib/config.cjs@92101ca `implicitToggleWarnings`.
 */
export function findImplicitLegacyToggleWarnings(raw: LegacyKitRaw): string[] {
	const top = isPlainRecord(raw.toggles) ? raw.toggles : {};
	const warnings: string[] = [];
	for (const project of listLegacyKitProjects(raw)) {
		const own = isPlainRecord(project.raw.toggles) ? project.raw.toggles : {};
		for (const name of LEGACY_KIT_PROJECT_TOGGLES) {
			if (own[name] === undefined && top[name] === true) {
				warnings.push(
					`project ${project.workspaceId}: top-level toggles.${name}=true no longer applies to it (K-1: off unless the project entry sets it); set projects[].toggles.${name} explicitly`,
				);
			}
		}
	}
	return warnings;
}

export type LegacyKitServiceName = "autoland" | "column-sync" | "review-watch" | "model-lists";

const LEGACY_KIT_SERVICES: ReadonlyArray<{ name: LegacyKitServiceName; pidFile: string; script: string }> = [
	{ name: "autoland", pidFile: "kanban-autoland.pid", script: "kanban-autoland.mjs" },
	{ name: "column-sync", pidFile: "kanban-column-sync.pid", script: "kanban-column-sync.mjs" },
	{ name: "review-watch", pidFile: "review-watch.pid", script: "review-watch.mjs" },
	{ name: "model-lists", pidFile: "model-lists.pid", script: "model-lists.mjs" },
];

export interface LegacyKitService {
	name: LegacyKitServiceName;
	/** `run/<name>.disabled` exists: the service is switched off and review-watch won't restart it. */
	disabled: boolean;
	/** The pid in its pid file when that process is alive and runs the service's script. */
	pid: number | null;
}

export interface LegacyKitProcessProbe {
	readFile: (path: string) => string | null;
	isAlive: (pid: number) => boolean;
	/** The process's argv, or null when it can't be read (no /proc). */
	readCommandLine: (pid: number) => string[] | null;
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export const defaultLegacyKitProcessProbe: LegacyKitProcessProbe = {
	readFile: readTextOrNull,
	isAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
		}
	},
	readCommandLine: (pid) => readTextOrNull(`/proc/${pid}/cmdline`)?.split("\0").filter(Boolean) ?? null,
};

/** The kit's run dir: its config's `runDir` (with `<kitHome>`), else <kit home>/run. */
export function getLegacyKitRunPath(raw: LegacyKitRaw | null): string {
	if (typeof raw?.runDir === "string" && raw.runDir.trim()) {
		const kitHome = getLegacyKitHomePath();
		return expandKanbanConfigPath(raw.runDir.replaceAll("<kitHome>", kitHome), kitHome);
	}
	return getLegacyKitDefaultRunPath();
}

export function readLegacyKitServices(
	raw: LegacyKitRaw | null,
	probe: LegacyKitProcessProbe = defaultLegacyKitProcessProbe,
): LegacyKitService[] {
	const runPath = getLegacyKitRunPath(raw);
	return LEGACY_KIT_SERVICES.map((service) => {
		const disabled = probe.readFile(join(runPath, `${service.name}.disabled`)) !== null;
		const pidText = probe.readFile(join(runPath, service.pidFile))?.trim();
		const pid = pidText && /^\d+$/u.test(pidText) ? Number(pidText) : null;
		if (pid === null || pid <= 1 || !probe.isAlive(pid)) {
			return { name: service.name, disabled, pid: null };
		}
		// A reused pid is not the service: when the command line is readable it must name the service's script.
		const commandLine = probe.readCommandLine(pid);
		const runsScript = commandLine === null || commandLine.some((arg) => arg.endsWith(`/${service.script}`));
		return { name: service.name, disabled, pid: runsScript ? pid : null };
	});
}

/**
 * Whether the service owns its responsibility: it runs, or it is not switched off (review-watch and the bashrc hook
 * start a stopped service again; archive/devteam-kit@accb937: stopping one for good needs its `.disabled` file).
 */
export function legacyKitServiceOwns(service: LegacyKitService | undefined, kitInstalled: boolean): boolean {
	if (!service || !kitInstalled) {
		return false;
	}
	return service.pid !== null || !service.disabled;
}
