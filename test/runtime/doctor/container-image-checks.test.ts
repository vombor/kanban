// Doctor's image channel row (src/doctor/container-image-checks.ts): the setting against the running image's stamp,
// and what the channel's tag holds. GHCR is faked.
import { describe, expect, it, vi } from "vitest";

import { checkContainerImageChannel } from "../../../src/doctor/container-image-checks";
import type { ContainerImageBuild } from "../../../src/update/container-image";

const BRANCH: ContainerImageBuild = { revision: "aaaaaaa1111", created: "2026-10-11T06:20:00.000Z", version: null };
const R7: ContainerImageBuild = { ...BRANCH, version: "0.1.70-fork.7" };
const R8: ContainerImageBuild = {
	revision: "bbbbbbb2222",
	created: "2026-10-12T06:20:00.000Z",
	version: "0.1.70-fork.8",
	digest: "sha256:r8",
};

function deps(running: ContainerImageBuild | null, target: ContainerImageBuild | Error) {
	const fetchChannelBuild = vi.fn(async () => {
		if (target instanceof Error) {
			throw target;
		}
		return target;
	});
	return { isInContainer: () => true, readRunningBuild: () => running, fetchChannelBuild };
}

describe("checkContainerImageChannel", () => {
	it("has no row outside a container", async () => {
		expect(await checkContainerImageChannel("stable", { ...deps(R7, R8), isInContainer: () => false })).toEqual([]);
	});

	it("warns about a release build while following latest, and asks nothing of the registry", async () => {
		const fake = deps(R7, R8);
		const [finding] = await checkContainerImageChannel("latest", fake);
		expect(finding?.level).toBe("warn");
		expect(finding?.message).toContain("The running image is release v0.1.70-fork.7");
		expect(finding?.message).toContain("never as :latest, but update.imageChannel is latest");
		expect(finding?.message).toContain("Kanban can't see the Quadlet unit");
		expect(finding?.hint).toBe("kanban config set update.imageChannel stable");
		expect(fake.fetchChannelBuild).not.toHaveBeenCalled();
	});

	it("warns about a non-release build while following stable", async () => {
		const [finding] = await checkContainerImageChannel("stable", deps(BRANCH, R8));
		expect(finding?.level).toBe("warn");
		expect(finding?.message).toContain("update.imageChannel is stable, but the running image is a non-release build");
		expect(finding?.message).toContain("set its Image= to ghcr.io/vombor/kanban:stable");
		expect(finding?.hint).toBe("kanban config unset update.imageChannel");
	});

	it("names a newer release on stable with its notes, and passes on the latest release", async () => {
		const fake = deps(R7, R8);
		const [newer] = await checkContainerImageChannel("stable", fake);
		expect(fake.fetchChannelBuild).toHaveBeenCalledWith("stable");
		expect(newer?.level).toBe("info");
		expect(newer?.message).toBe(
			"Image channel stable: v0.1.70-fork.8 is out (running v0.1.70-fork.7); release notes: https://github.com/vombor/kanban/releases/tag/v0.1.70-fork.8. Update with kanban restart update once no card is In Progress.",
		);
		expect(newer?.hint).toBe("kanban restart update --dry-run");

		const [current] = await checkContainerImageChannel("stable", deps({ ...R8, digest: null }, R8));
		expect(current).toEqual({
			level: "pass",
			area: "setup",
			message: "Image channel stable: running v0.1.70-fork.8, the latest release.",
		});
	});

	it("on latest says whether :latest has a newer build", async () => {
		const later = { ...BRANCH, revision: "ccccccc3333", created: "2026-10-12T06:20:00.000Z" };
		const [newer] = await checkContainerImageChannel("latest", deps(BRANCH, later));
		expect(newer?.message).toContain(
			"Image channel latest: ghcr.io/vombor/kanban:latest has a newer build (ccccccc (built 2026-10-12 06:20Z); running aaaaaaa (built 2026-10-11 06:20Z))",
		);
		const [current] = await checkContainerImageChannel("latest", deps(BRANCH, BRANCH));
		expect(current?.level).toBe("pass");
	});

	it("reports an unreadable registry and an unstamped image as info", async () => {
		const [down] = await checkContainerImageChannel("stable", deps(R7, new Error("HTTP 503")));
		expect(down?.level).toBe("info");
		expect(down?.message).toContain("could not read ghcr.io/vombor/kanban:stable from the registry (HTTP 503)");
		const [unstamped] = await checkContainerImageChannel("stable", deps(null, R8));
		expect(unstamped?.message).toContain("The running image has no build stamp");
	});
});
