// Doctor row: the pod's image channel (`update.imageChannel`, src/update/container-image.ts) against the image that runs.
// Kanban can't see the Quadlet unit, so this never claims what its `Image=` says: it tells only what the running
// image's own stamp shows. A release build (KANBAN_IMAGE_VERSION set) is never pushed as `:latest`, and a `:stable`
// image is always one, so a release build on `latest` or a non-release build on `stable` means the setting and the
// unit's tag disagree, or the pod was started on another tag. When they agree, the row reads the channel's tag from
// the registry and says whether an update is out ("v0.1.70-fork.8 is out (running v0.1.70-fork.7)" on stable).
// Outside a container there is no row.
import {
	type ContainerImageBuild,
	compareImageBuilds,
	describeChannelRelease,
	describeImageBuild,
	fetchLatestImageBuild,
	getChannelImageRef,
	getImageRelease,
	getImageReleaseUrl,
	isRunningInContainer,
	KANBAN_IMAGE_VERSION_ENV,
	readRunningImageBuild,
} from "../update/container-image";
import type { KanbanImageChannel } from "../update/image-channel";
import type { DoctorFinding } from "./doctor-report";

export interface ContainerImageCheckDeps {
	isInContainer?: () => boolean;
	readRunningBuild?: () => ContainerImageBuild | null;
	fetchChannelBuild?: (channel: KanbanImageChannel) => Promise<ContainerImageBuild>;
}

const SET_STABLE = "kanban config set update.imageChannel stable";
const SET_LATEST = "kanban config unset update.imageChannel";

function toErrorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message : String(error);
}

export async function checkContainerImageChannel(
	channel: KanbanImageChannel,
	deps: ContainerImageCheckDeps = {},
): Promise<DoctorFinding[]> {
	if (!(deps.isInContainer ?? (() => isRunningInContainer()))()) {
		return [];
	}
	const running = (deps.readRunningBuild ?? (() => readRunningImageBuild()))();
	const imageRef = getChannelImageRef(channel);
	if (!running) {
		return [
			{
				level: "info",
				area: "setup",
				message: `The running image has no build stamp (not an image CI built), so update.imageChannel (${channel}) can't be checked against it and kanban restart update refuses without --force.`,
			},
		];
	}
	const release = getImageRelease(running);
	if (channel === "latest" && release) {
		return [
			{
				level: "warn",
				area: "setup",
				message: `The running image is release ${release} (${describeImageBuild(running)}), which CI pushes as :stable and its version tag, never as :latest, but update.imageChannel is latest: kanban restart update compares with ${imageRef}. Kanban can't see the Quadlet unit; if its Image= is ghcr.io/vombor/kanban:stable, set the channel to stable.`,
				hint: SET_STABLE,
			},
		];
	}
	if (channel === "stable" && !release) {
		return [
			{
				level: "warn",
				area: "setup",
				message: `update.imageChannel is stable, but the running image is a non-release build (${describeImageBuild(running)}, no ${KANBAN_IMAGE_VERSION_ENV}): a :latest or branch image, which :stable never is. Kanban can't see the Quadlet unit; set its Image= to ${imageRef} (docs/fork/container-lifecycle.md) and restart the unit, or follow latest again.`,
				hint: SET_LATEST,
			},
		];
	}

	let target: ContainerImageBuild;
	try {
		target = await (deps.fetchChannelBuild ?? ((tag) => fetchLatestImageBuild({ channel: tag, timeoutMs: 5_000 })))(
			channel,
		);
	} catch (error) {
		return [
			{
				level: "info",
				area: "setup",
				message: `Image channel ${channel}: running ${describeImageBuild(running)}; could not read ${imageRef} from the registry (${toErrorMessage(error)}).`,
			},
		];
	}
	const check = compareImageBuilds(running, target);
	const headline =
		describeChannelRelease(channel, running, target) ??
		(check.kind === "newer"
			? `${imageRef} has a newer build (${describeImageBuild(target)}; running ${describeImageBuild(running)})`
			: `running ${describeImageBuild(running)}, ${check.kind === "current" ? "the build" : "newer than the build"} ${imageRef} holds`);
	if (check.kind === "newer") {
		const notes = getImageRelease(target) !== release ? getImageReleaseUrl(target) : null;
		return [
			{
				level: "info",
				area: "setup",
				message: `Image channel ${channel}: ${headline}${notes ? `; release notes: ${notes}` : ""}. Update with kanban restart update once no card is In Progress.`,
				hint: "kanban restart update --dry-run",
			},
		];
	}
	return [{ level: "pass", area: "setup", message: `Image channel ${channel}: ${headline}.` }];
}
