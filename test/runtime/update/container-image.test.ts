// The pod image's build stamp and the registry's :latest (src/update/container-image.ts), for `kanban restart update`.
import { describe, expect, it, vi } from "vitest";

import {
	compareImageBuilds,
	describeImageBuild,
	fetchLatestImageBuild,
	isRunningInContainer,
	readRunningImageBuild,
} from "../../../src/update/container-image";

const OLD = { revision: "aaaaaaa1111", created: "2026-10-11T06:20:00.000Z", digest: null };
const NEW = { revision: "bbbbbbb2222", created: "2026-10-12T06:20:00.000Z", digest: "sha256:new" };

describe("container image builds", () => {
	it("reads the running build from the image's env, null without a stamp", () => {
		expect(readRunningImageBuild({ KANBAN_IMAGE_REVISION: OLD.revision, KANBAN_IMAGE_CREATED: OLD.created })).toEqual(
			OLD,
		);
		expect(readRunningImageBuild({ KANBAN_IMAGE_REVISION: " ", KANBAN_IMAGE_CREATED: "" })).toBeNull();
		expect(readRunningImageBuild({})).toBeNull();
	});

	it("tells a newer, the same, an older and an unstamped running build apart", () => {
		expect(compareImageBuilds(OLD, NEW).kind).toBe("newer");
		expect(compareImageBuilds(NEW, { ...NEW, digest: "sha256:x" }).kind).toBe("current");
		expect(compareImageBuilds(NEW, OLD).kind).toBe("older");
		expect(compareImageBuilds(null, NEW).kind).toBe("unknown_running");
		// A daily rebuild of the same commit (new agent CLIs) is newer too.
		expect(compareImageBuilds(OLD, { ...OLD, created: NEW.created }).kind).toBe("newer");
		// Without times, another commit counts as newer.
		expect(compareImageBuilds({ ...OLD, created: null }, { ...NEW, created: null }).kind).toBe("newer");
	});

	it("describes a build by its short commit and build time", () => {
		expect(describeImageBuild(OLD)).toBe("aaaaaaa (built 2026-10-11 06:20Z)");
		expect(describeImageBuild(null)).toBe("an unknown build");
		expect(describeImageBuild({ revision: "c0ffee12", created: null })).toBe("c0ffee1");
	});

	it("is in a container only with podman's /run/.containerenv", () => {
		expect(isRunningInContainer((path) => path === "/run/.containerenv")).toBe(true);
		expect(isRunningInContainer(() => false)).toBe(false);
	});
});

describe("fetchLatestImageBuild", () => {
	it("follows the index to the platform's image and reads its labels; the blob redirect gets no token", async () => {
		const calls: Array<{ url: string; auth: string | null }> = [];
		const json = (body: unknown, headers: Record<string, string> = {}) =>
			new Response(JSON.stringify(body), { status: 200, headers });
		const fetchFake = vi.fn(async (url: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			calls.push({ url, auth: headers.get("authorization") });
			if (url.startsWith("https://ghcr.io/token")) {
				return json({ token: "anon" });
			}
			if (url.endsWith("/manifests/latest")) {
				return json(
					{
						manifests: [
							{ digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } },
							{ digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
						],
					},
					{ "docker-content-digest": "sha256:index" },
				);
			}
			if (url.endsWith("/manifests/sha256:amd")) {
				return json({ config: { digest: "sha256:cfg" } });
			}
			if (url.endsWith("/blobs/sha256:cfg")) {
				return new Response(null, { status: 307, headers: { location: "https://storage.example/cfg?sig=1" } });
			}
			if (url === "https://storage.example/cfg?sig=1") {
				return json({
					config: {
						Labels: {
							"org.opencontainers.image.revision": NEW.revision,
							"org.opencontainers.image.created": NEW.created,
						},
					},
				});
			}
			return new Response("not found", { status: 404 });
		});
		expect(await fetchLatestImageBuild({ fetch: fetchFake, architecture: "amd64" })).toEqual({
			revision: NEW.revision,
			created: NEW.created,
			digest: "sha256:index",
		});
		expect(calls.find((call) => call.url.endsWith("/manifests/latest"))?.auth).toBe("Bearer anon");
		expect(calls.find((call) => call.url.startsWith("https://storage.example"))?.auth).toBeNull();
	});

	it("fails on an HTTP error or a missing platform", async () => {
		const failing = vi.fn(async () => new Response("", { status: 503 }));
		await expect(fetchLatestImageBuild({ fetch: failing })).rejects.toThrow("registry token: HTTP 503");
		const noPlatform = vi.fn(async (url: string) =>
			url.includes("/token")
				? new Response(JSON.stringify({ token: "t" }))
				: new Response(JSON.stringify({ manifests: [] })),
		);
		await expect(fetchLatestImageBuild({ fetch: noPlatform, architecture: "arm64" })).rejects.toThrow(
			"no linux/arm64 image",
		);
	});
});
