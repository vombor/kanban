// The restart wake after `kanban restart update` (src/pipeline/watchdog/restart-wake.ts): the manifest's update makes
// the stop line "updated from <old build> to <new build>".
import { describe, expect, it } from "vitest";

import type { RestartManifest } from "../../../../src/pipeline/restart-recovery";
import {
	buildRestartWakeItem,
	describePreviousStop,
	type RestartWakeItemInput,
	summarizeRestartRecords,
} from "../../../../src/pipeline/watchdog/restart-wake";
import { watchdogWorkspaceStateSchema } from "../../../../src/pipeline/watchdog/watchdog-state";

const PREVIOUS_START = Date.parse("2026-10-12T08:00:00.000Z");
const START = Date.parse("2026-10-12T10:00:00.000Z");
const OLD = { revision: "aaaaaaa1111", created: "2026-10-11T06:20:00.000Z", digest: null };
const NEW = { revision: "bbbbbbb2222", created: "2026-10-12T06:20:00.000Z", digest: "sha256:new" };

const manifest: RestartManifest = {
	at: "2026-10-12T09:59:50.000Z",
	kanbanStart: new Date(PREVIOUS_START).toISOString(),
	source: "prepare",
	update: { from: OLD, to: NEW },
	cards: [],
};

function item(runningBuild: RestartWakeItemInput["runningBuild"]): string {
	return buildRestartWakeItem({
		serverStartedAt: START,
		stop: describePreviousStop(manifest, START, PREVIOUS_START),
		runningBuild,
		recoveryNotRunning: null,
		passRan: true,
		summary: summarizeRestartRecords([]),
		session: null,
	});
}

describe("the restart wake after an update restart", () => {
	it("is a planned stop carrying the update", () => {
		expect(describePreviousStop(manifest, START, PREVIOUS_START)).toEqual({
			kind: "planned",
			at: manifest.at,
			update: { from: OLD, to: NEW },
		});
		const { update: _update, ...plain } = manifest;
		expect(describePreviousStop(plain, START, PREVIOUS_START)).toEqual({ kind: "planned", at: manifest.at });
	});

	it("says updated from the old build to the build this server runs", () => {
		expect(item({ ...NEW, digest: null })).toContain(
			"the restart was an update (kanban restart update at 2026-10-12 09:59:50Z): updated from aaaaaaa (built 2026-10-11 06:20Z) to bbbbbbb (built 2026-10-12 06:20Z);",
		);
		// Without the new server's stamp: the build the update asked for.
		expect(item(null)).toContain("to bbbbbbb (built 2026-10-12 06:20Z) (the registry's :latest then)");
	});

	it("says so when the container came back on the old build", () => {
		expect(item(OLD)).toContain(
			"but this server still runs aaaaaaa (built 2026-10-11 06:20Z): the container started without the newer image (bbbbbbb (built 2026-10-12 06:20Z)), so check the Quadlet unit's Pull=newer",
		);
	});

	it("keeps the update in the watchdog state", () => {
		const parsed = watchdogWorkspaceStateSchema.parse({
			restartWake: {
				serverStartedAt: START,
				firstSeenAt: new Date(START).toISOString(),
				stop: describePreviousStop(manifest, START, PREVIOUS_START),
			},
		});
		expect(parsed.restartWake?.stop?.update).toEqual({ from: OLD, to: NEW });
	});
});
