// `kanban restart update`'s CLI side (src/commands/restart.ts): it only sends the request and prints the server's
// answer; every decision is the server's (test/runtime/trpc/restart-update-api.test.ts).
import { describe, expect, it, vi } from "vitest";

import { runRestartUpdateCommand } from "../../../src/commands/restart";

describe("kanban restart update", () => {
	it("sends --force/--dry-run and prints the lines and the answer; a refusal exits 1", async () => {
		const update = vi.fn(async () => ({
			status: "refused" as const,
			message: "Already on the latest image (aaaaaaa): nothing to update.",
			lines: ["running: aaaaaaa"],
		}));
		expect(await runRestartUpdateCommand({ dryRun: true }, update)).toEqual({
			stdout: "running: aaaaaaa\nrefused: Already on the latest image (aaaaaaa): nothing to update.\n",
			exitCode: 1,
		});
		expect(update).toHaveBeenCalledWith({ force: false, dryRun: true });

		const restarting = vi.fn(async () => ({
			status: "restarting" as const,
			message: "Restarting the container",
			lines: [],
		}));
		expect(await runRestartUpdateCommand({ force: true }, restarting)).toEqual({
			stdout: "Restarting the container\n",
			exitCode: 0,
		});
		expect(restarting).toHaveBeenCalledWith({ force: true, dryRun: false });
	});
});
