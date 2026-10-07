// PID pressure. Zombies reparented to PID 1 (`npm exec kanban` never reaps) fill the container cgroup's pids.max;
// at the limit Kanban's git calls fail and it once wiped a board (10/04). Two levels:
//   pressure (`watchdog.pids.pressure`, 0.75): hold new work (QA cards, calibration waves; `<home>/run/pid-pressure`
//            tells them) and run the orphan process sweep (src/server/orphan-process-sweeper.ts) so processes left
//            in Done cards' worktrees go first; its zombie count goes into ATTENTION.md;
//   brownout (`watchdog.pids.brownout`, 0.9): also pause each running agent once (Esc), because at the limit nothing
//            can fork. Resuming a started card is held only here, never under pressure alone (bfb20 10/05).
// Only a container restart with an init as PID 1 (quadlet RunInit=true) clears zombies, so the item is for a human
// and never wakes the orchestrator.
//
// Ported from archive/devteam-kit:services/review-watch.mjs@6da71597 (pidUse and the PID pressure block; 4e426fc,
// 3e47f52, d9aaa7c). The process sweep replaces nothing in the legacy kit: it is how the fork's reaper is reused here.
import { readFile } from "node:fs/promises";

import { PID_PRESSURE_ITEM_MARKER } from "./attention";

export interface PidUsage {
	current: number;
	max: number;
}

export type PidPressureLevel = "none" | "pressure" | "brownout";

const CGROUP_PIDS_MAX = "/sys/fs/cgroup/pids.max";
const CGROUP_PIDS_CURRENT = "/sys/fs/cgroup/pids.current";

/** The container's PID use from cgroup v2, or null where there is no limit ("max") or no cgroup file. */
export async function readCgroupPidUsage(
	read: (path: string) => Promise<string> = async (path) => await readFile(path, "utf8"),
): Promise<PidUsage | null> {
	try {
		const max = Number((await read(CGROUP_PIDS_MAX)).trim());
		if (!Number.isFinite(max) || max <= 0) {
			return null;
		}
		const current = Number((await read(CGROUP_PIDS_CURRENT)).trim());
		return Number.isFinite(current) ? { current, max } : null;
	} catch {
		return null;
	}
}

export function getPidPressureLevel(
	usage: PidUsage | null,
	thresholds: { pressure: number; brownout: number },
): PidPressureLevel {
	if (!usage) {
		return "none";
	}
	const use = usage.current / usage.max;
	if (use > thresholds.brownout) {
		return "brownout";
	}
	return use > thresholds.pressure ? "pressure" : "none";
}

export function formatPidPressureItem(
	usage: PidUsage,
	level: Exclude<PidPressureLevel, "none">,
	sweep: { zombies: number; terminated: number } | null,
): string {
	const swept = sweep
		? ` The process sweep found ${sweep.zombies} zombie(s)${sweep.terminated > 0 ? ` and terminated ${sweep.terminated} orphan(s) of Done cards` : ""}.`
		: "";
	return `- ${PID_PRESSURE_ITEM_MARKER}: ${usage.current}/${usage.max} PIDs in use (mostly zombies under PID 1). New QA cards and calibration waves are held${level === "brownout" ? "; BROWNOUT: running agents were paused (resume after the restart)" : ""}.${swept} Needs a container restart with RunInit=true (human).`;
}
