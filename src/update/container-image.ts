// Which build of the pod's container image (ghcr.io/vombor/kanban) runs, and whether the registry's tag of the pod's
// channel (`update.imageChannel`: `:latest`, every fork/stack push, or `:stable`, the last release) is newer, for
// `kanban restart update` (src/trpc/restart-update-api.ts), the restart wake and doctor.
//
// The image carries its own build in its env: deploy/Containerfile turns the build args KANBAN_IMAGE_REVISION (the
// commit) and KANBAN_IMAGE_CREATED (docker/metadata-action's created time) into ENV, and CI passes the same values
// metadata-action writes as the image's `org.opencontainers.image.revision`/`.created` labels. So the running build
// is read from the env and the registry's from the labels of the channel tag's config, fetched anonymously (GHCR
// answers an anonymous pull token for a public package). A release build (image.yml on a `v*` tag) also carries its
// version as KANBAN_IMAGE_VERSION and the RELEASE_LABEL label; every other build has neither. The pod can't read its
// own image digest (/run/.containerenv names the image only for privileged containers) nor its Quadlet unit, which is
// why the comparison goes by these labels and the channel is a setting that must match the unit's `Image=` tag.
import { existsSync } from "node:fs";
import { z } from "zod";

import { DEFAULT_KANBAN_IMAGE_CHANNEL, type KanbanImageChannel } from "./image-channel";

export const KANBAN_CONTAINER_IMAGE_REGISTRY = "ghcr.io";
export const KANBAN_CONTAINER_IMAGE_REPOSITORY = "vombor/kanban";

/** The env variables deploy/Containerfile sets from its build args. */
export const KANBAN_IMAGE_REVISION_ENV = "KANBAN_IMAGE_REVISION";
export const KANBAN_IMAGE_CREATED_ENV = "KANBAN_IMAGE_CREATED";
/** The release version (package.json's, e.g. `0.1.70-fork.8`); empty in every build that isn't a release's. */
export const KANBAN_IMAGE_VERSION_ENV = "KANBAN_IMAGE_VERSION";

const REVISION_LABEL = "org.opencontainers.image.revision";
const CREATED_LABEL = "org.opencontainers.image.created";
/**
 * image.yml's own label with KANBAN_IMAGE_VERSION's value. Not metadata-action's `org.opencontainers.image.version`,
 * which on a branch push is the branch name (`fork-stack`).
 */
export const RELEASE_LABEL = "dev.vombor.kanban.release";

/** publish.yml creates a GitHub release for every version tag, with the tag's CHANGELOG.md section as its body. */
const RELEASES_URL = `https://github.com/${KANBAN_CONTAINER_IMAGE_REPOSITORY}/releases/tag`;

/** Podman writes it into every container it runs. */
export const CONTAINER_ENV_FILE = "/run/.containerenv";

export const containerImageBuildSchema = z.object({
	revision: z.string().nullable(),
	created: z.string().nullable(),
	/** The release version without the `v` (`0.1.70-fork.8`); null or missing for a build that isn't a release's. */
	version: z.string().nullable().optional(),
	/** The registry's manifest digest of the tag; null for the running build (the pod can't read its own). */
	digest: z.string().nullable().optional(),
});
export type ContainerImageBuild = z.infer<typeof containerImageBuildSchema>;

export function getChannelImageRef(channel: KanbanImageChannel): string {
	return `${KANBAN_CONTAINER_IMAGE_REGISTRY}/${KANBAN_CONTAINER_IMAGE_REPOSITORY}:${channel}`;
}

export function isRunningInContainer(fileExists: (path: string) => boolean = existsSync): boolean {
	return fileExists(CONTAINER_ENV_FILE);
}

function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | null {
	const value = env[name]?.trim();
	return value ? value : null;
}

function normalizeReleaseVersion(value: string | null | undefined): string | null {
	const version = value?.trim().replace(/^v/u, "");
	return version ? version : null;
}

/** The running image's build from its env; null outside an image CI built (a local build, a dev checkout). */
export function readRunningImageBuild(env: NodeJS.ProcessEnv = process.env): ContainerImageBuild | null {
	const revision = readEnvValue(env, KANBAN_IMAGE_REVISION_ENV);
	const created = readEnvValue(env, KANBAN_IMAGE_CREATED_ENV);
	if (!revision && !created) {
		return null;
	}
	return { revision, created, version: normalizeReleaseVersion(env[KANBAN_IMAGE_VERSION_ENV]), digest: null };
}

/** The build's release, "v0.1.70-fork.8", or null for a build that isn't a release's. */
export function getImageRelease(build: ContainerImageBuild | null | undefined): string | null {
	const version = normalizeReleaseVersion(build?.version);
	return version ? `v${version}` : null;
}

/** The GitHub release page of a release build, null for any other build. */
export function getImageReleaseUrl(build: ContainerImageBuild | null | undefined): string | null {
	const release = getImageRelease(build);
	return release ? `${RELEASES_URL}/${release}` : null;
}

function formatBuildTime(build: ContainerImageBuild): string | null {
	const createdAt = build.created ? Date.parse(build.created) : Number.NaN;
	if (Number.isFinite(createdAt)) {
		return `built ${new Date(createdAt).toISOString().replace("T", " ").slice(0, 16)}Z`;
	}
	return build.created ? `built ${build.created}` : null;
}

/**
 * "a1b2c3d (built 2026-10-12 06:20Z)" for logs and the restart wake; a release build leads with its version:
 * "v0.1.70-fork.8 (a1b2c3d, built 2026-10-12 06:20Z)".
 */
export function describeImageBuild(build: ContainerImageBuild | null | undefined): string {
	if (!build || (!build.revision && !build.created)) {
		return "an unknown build";
	}
	const built = formatBuildTime(build);
	const revision = build.revision ? build.revision.slice(0, 7) : "unknown commit";
	const release = getImageRelease(build);
	if (release) {
		return `${release} (${[revision, built].filter(Boolean).join(", ")})`;
	}
	return built ? `${revision} (${built})` : revision;
}

/** Whether two builds are the same image build (same commit and build time). */
export function isSameImageBuild(left: ContainerImageBuild | null, right: ContainerImageBuild | null): boolean {
	if (!left || !right) {
		return false;
	}
	return left.revision === right.revision && left.created === right.created;
}

export type ImageUpdateCheck =
	/** The channel's tag is a later build than the running one. */
	| { kind: "newer" }
	/** The running build is the channel's tag. */
	| { kind: "current" }
	/** The channel's tag is an earlier build (the pod runs a branch image or a later local build). */
	| { kind: "older" }
	/** The running image has no build stamp: nothing to compare. */
	| { kind: "unknown_running" };

/**
 * `podman run --pull=newer` pulls when the digests differ; this tells whether that would be an update. A build with
 * no parseable created time falls back to "a different commit is newer".
 */
export function compareImageBuilds(running: ContainerImageBuild | null, latest: ContainerImageBuild): ImageUpdateCheck {
	if (!running) {
		return { kind: "unknown_running" };
	}
	if (isSameImageBuild(running, latest)) {
		return { kind: "current" };
	}
	const runningAt = running.created ? Date.parse(running.created) : Number.NaN;
	const latestAt = latest.created ? Date.parse(latest.created) : Number.NaN;
	if (Number.isFinite(runningAt) && Number.isFinite(latestAt)) {
		if (latestAt > runningAt) {
			return { kind: "newer" };
		}
		return latestAt < runningAt ? { kind: "older" } : { kind: "current" };
	}
	return running.revision !== latest.revision ? { kind: "newer" } : { kind: "current" };
}

/** "v0.1.70-fork.7" for a release build, else "a non-release build a1b2c3d (built …)". */
function describeRunningForRelease(running: ContainerImageBuild | null): string {
	if (!running) {
		return "an unknown build";
	}
	return getImageRelease(running) ?? `a non-release build ${describeImageBuild(running)}`;
}

/**
 * The headline of what the channel's tag holds against the running build, for restart update, doctor and the wake.
 * On `stable` it names releases: "v0.1.70-fork.8 is out (running v0.1.70-fork.7)", "running v0.1.70-fork.8, the
 * latest release", another build of the same release, or a `:stable` without a release stamp. Null on `latest`,
 * whose lines name the builds as before.
 */
export function describeChannelRelease(
	channel: KanbanImageChannel,
	running: ContainerImageBuild | null,
	target: ContainerImageBuild,
): string | null {
	if (channel !== "stable") {
		return null;
	}
	const targetRelease = getImageRelease(target);
	if (!targetRelease) {
		return `${getChannelImageRef(channel)} carries no release version (${describeImageBuild(target)}): not a build of a release tag`;
	}
	const runningRelease = getImageRelease(running);
	if (runningRelease === targetRelease) {
		return isSameImageBuild(running, target)
			? `running ${targetRelease}, the latest release`
			: `${getChannelImageRef(channel)} is another build of ${targetRelease} (${describeImageBuild(target)}; running ${describeImageBuild(running)})`;
	}
	return `${targetRelease} is out (running ${describeRunningForRelease(running)})`;
}

const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const tokenResponseSchema = z.object({ token: z.string().optional(), access_token: z.string().optional() });
const manifestSchema = z
	.object({
		manifests: z
			.array(
				z.object({
					digest: z.string(),
					platform: z.object({ os: z.string().optional(), architecture: z.string().optional() }).optional(),
				}),
			)
			.optional(),
		config: z.object({ digest: z.string() }).optional(),
	})
	.passthrough();
const configBlobSchema = z
	.object({ config: z.object({ Labels: z.record(z.string(), z.string()).nullable().optional() }).optional() })
	.passthrough();

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchLatestImageBuildOptions {
	fetch?: FetchLike;
	/** The tag to read; defaults to `latest`. */
	channel?: KanbanImageChannel;
	/** The OCI architecture to pick from a multi-platform index; defaults to this process's. */
	architecture?: string;
	timeoutMs?: number;
}

function toOciArchitecture(arch: string): string {
	return arch === "x64" ? "amd64" : arch === "ia32" ? "386" : arch;
}

async function readJson(response: Response, what: string): Promise<unknown> {
	if (!response.ok) {
		throw new Error(`${what}: HTTP ${response.status}`);
	}
	return await response.json();
}

/** The registry's build of the channel's tag: its manifest digest and its config's build labels. */
export async function fetchLatestImageBuild(options: FetchLatestImageBuildOptions = {}): Promise<ContainerImageBuild> {
	const fetchImpl = options.fetch ?? fetch;
	const tag = options.channel ?? DEFAULT_KANBAN_IMAGE_CHANNEL;
	const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
	const base = `https://${KANBAN_CONTAINER_IMAGE_REGISTRY}`;
	const repository = KANBAN_CONTAINER_IMAGE_REPOSITORY;
	const tokenAnswer = tokenResponseSchema.parse(
		await readJson(
			await fetchImpl(
				`${base}/token?scope=repository:${repository}:pull&service=${KANBAN_CONTAINER_IMAGE_REGISTRY}`,
				{ signal },
			),
			"registry token",
		),
	);
	const token = tokenAnswer.token ?? tokenAnswer.access_token;
	if (!token) {
		throw new Error("registry token: no token in the answer");
	}
	const authorization = { Authorization: `Bearer ${token}` };
	const readManifest = async (reference: string) => {
		const response = await fetchImpl(`${base}/v2/${repository}/manifests/${reference}`, {
			headers: { ...authorization, Accept: MANIFEST_ACCEPT },
			signal,
		});
		const manifest = manifestSchema.parse(await readJson(response, `manifest ${reference}`));
		return { manifest, digest: response.headers.get("docker-content-digest") };
	};
	const tagged = await readManifest(tag);
	let image = tagged.manifest;
	if (tagged.manifest.manifests) {
		const architecture = options.architecture ?? toOciArchitecture(process.arch);
		const entry = tagged.manifest.manifests.find(
			(candidate) => candidate.platform?.os === "linux" && candidate.platform.architecture === architecture,
		);
		if (!entry) {
			throw new Error(`manifest ${tag}: no linux/${architecture} image`);
		}
		image = (await readManifest(entry.digest)).manifest;
	}
	if (!image.config) {
		throw new Error(`manifest ${tag}: no config`);
	}
	// GHCR answers a blob with a redirect to its storage, which must not get the registry token.
	let blob = await fetchImpl(`${base}/v2/${repository}/blobs/${image.config.digest}`, {
		headers: authorization,
		redirect: "manual",
		signal,
	});
	const location = blob.headers.get("location");
	if (blob.status >= 300 && blob.status < 400 && location) {
		blob = await fetchImpl(new URL(location, base).toString(), { signal });
	}
	const labels = configBlobSchema.parse(await readJson(blob, "image config")).config?.Labels ?? {};
	return {
		revision: labels[REVISION_LABEL] ?? null,
		created: labels[CREATED_LABEL] ?? null,
		version: normalizeReleaseVersion(labels[RELEASE_LABEL]),
		digest: tagged.digest,
	};
}
