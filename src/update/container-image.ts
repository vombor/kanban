// Which build of the pod's container image (ghcr.io/vombor/kanban) runs, and whether the registry's `:latest` is
// newer, for `kanban restart update` (src/trpc/restart-update-api.ts).
//
// The image carries its own build in its env: deploy/Containerfile turns the build args KANBAN_IMAGE_REVISION (the
// commit) and KANBAN_IMAGE_CREATED (docker/metadata-action's created time) into ENV, and CI passes the same values
// metadata-action writes as the image's `org.opencontainers.image.revision`/`.created` labels. So the running build
// is read from the env and the registry's from the labels of `:latest`'s config, fetched anonymously (GHCR answers
// an anonymous pull token for a public package). The pod can't read its own image digest (/run/.containerenv names the
// image only for privileged containers), which is why the comparison goes by these labels.
import { existsSync } from "node:fs";
import { z } from "zod";

export const KANBAN_CONTAINER_IMAGE_REGISTRY = "ghcr.io";
export const KANBAN_CONTAINER_IMAGE_REPOSITORY = "vombor/kanban";
export const KANBAN_CONTAINER_IMAGE_TAG = "latest";

/** The env variables deploy/Containerfile sets from its build args. */
export const KANBAN_IMAGE_REVISION_ENV = "KANBAN_IMAGE_REVISION";
export const KANBAN_IMAGE_CREATED_ENV = "KANBAN_IMAGE_CREATED";

const REVISION_LABEL = "org.opencontainers.image.revision";
const CREATED_LABEL = "org.opencontainers.image.created";

/** Podman writes it into every container it runs. */
export const CONTAINER_ENV_FILE = "/run/.containerenv";

export const containerImageBuildSchema = z.object({
	revision: z.string().nullable(),
	created: z.string().nullable(),
	/** The registry's manifest digest of the tag; null for the running build (the pod can't read its own). */
	digest: z.string().nullable().optional(),
});
export type ContainerImageBuild = z.infer<typeof containerImageBuildSchema>;

export function isRunningInContainer(fileExists: (path: string) => boolean = existsSync): boolean {
	return fileExists(CONTAINER_ENV_FILE);
}

function readEnvValue(env: NodeJS.ProcessEnv, name: string): string | null {
	const value = env[name]?.trim();
	return value ? value : null;
}

/** The running image's build from its env; null outside an image CI built (a local build, a dev checkout). */
export function readRunningImageBuild(env: NodeJS.ProcessEnv = process.env): ContainerImageBuild | null {
	const revision = readEnvValue(env, KANBAN_IMAGE_REVISION_ENV);
	const created = readEnvValue(env, KANBAN_IMAGE_CREATED_ENV);
	return revision || created ? { revision, created, digest: null } : null;
}

/** "a1b2c3d (built 2026-10-12 06:20Z)", for logs and the restart wake. */
export function describeImageBuild(build: ContainerImageBuild | null | undefined): string {
	if (!build || (!build.revision && !build.created)) {
		return "an unknown build";
	}
	const createdAt = build.created ? Date.parse(build.created) : Number.NaN;
	const built = Number.isFinite(createdAt)
		? `built ${new Date(createdAt).toISOString().replace("T", " ").slice(0, 16)}Z`
		: build.created
			? `built ${build.created}`
			: null;
	const revision = build.revision ? build.revision.slice(0, 7) : "unknown commit";
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
	/** `:latest` is a later build than the running one. */
	| { kind: "newer" }
	/** The running build is `:latest`. */
	| { kind: "current" }
	/** `:latest` is an earlier build (the pod runs a branch image or a later local build). */
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

/** The registry's `:latest` build: its manifest digest and its config's build labels. */
export async function fetchLatestImageBuild(options: FetchLatestImageBuildOptions = {}): Promise<ContainerImageBuild> {
	const fetchImpl = options.fetch ?? fetch;
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
	const tagged = await readManifest(KANBAN_CONTAINER_IMAGE_TAG);
	let image = tagged.manifest;
	if (tagged.manifest.manifests) {
		const architecture = options.architecture ?? toOciArchitecture(process.arch);
		const entry = tagged.manifest.manifests.find(
			(candidate) => candidate.platform?.os === "linux" && candidate.platform.architecture === architecture,
		);
		if (!entry) {
			throw new Error(`manifest ${KANBAN_CONTAINER_IMAGE_TAG}: no linux/${architecture} image`);
		}
		image = (await readManifest(entry.digest)).manifest;
	}
	if (!image.config) {
		throw new Error(`manifest ${KANBAN_CONTAINER_IMAGE_TAG}: no config`);
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
		digest: tagged.digest,
	};
}
