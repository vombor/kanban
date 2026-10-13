// `kanban config set|unset update.imageChannel`: which tag of ghcr.io/vombor/kanban the pod follows, as the user set it
// in the Quadlet unit's `Image=` (`latest` or `stable`; docs/fork/container-lifecycle.md). Kanban can't see the unit,
// so this setting is how `kanban restart update`, the restart wake and doctor know which tag to compare with. The write
// goes through updatePipelineConfigFile (config lock, atomic, every other key kept); unset means the default, latest.
import { getKanbanGlobalConfigPath } from "../state/kanban-home";
import { DEFAULT_KANBAN_IMAGE_CHANNEL, imageChannelSchema, KANBAN_IMAGE_CHANNELS } from "../update/image-channel";
import { updatePipelineConfigFile } from "./pipeline-config";

export const IMAGE_CHANNEL_KEY = "update.imageChannel";

export interface ImageChannelChange {
	key: string;
	from: unknown;
	to: string | null;
	configPath: string;
	next: string;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

async function writeImageChannel(channel: string | null, configPath: string): Promise<ImageChannelChange> {
	let from: unknown;
	await updatePipelineConfigFile((config) => {
		const update = asObject(config.update);
		from = update.imageChannel;
		if (channel === null) {
			delete update.imageChannel;
		} else {
			update.imageChannel = channel;
		}
		const next: Record<string, unknown> = { ...config, update };
		if (Object.keys(update).length === 0) {
			delete next.update;
		}
		return next;
	}, configPath);
	const tag = channel ?? DEFAULT_KANBAN_IMAGE_CHANNEL;
	return {
		key: IMAGE_CHANNEL_KEY,
		from,
		to: channel,
		configPath,
		next: `kanban restart update, the restart wake and doctor now compare with ghcr.io/vombor/kanban:${tag}. The Quadlet unit's Image= must name the same tag (Kanban can't see the unit); kanban doctor says when the running image doesn't look like a :${tag} build.`,
	};
}

export async function setImageChannel(
	value: string,
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ImageChannelChange> {
	const parsed = imageChannelSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`${IMAGE_CHANNEL_KEY} is one of ${KANBAN_IMAGE_CHANNELS.join(", ")}, not ${JSON.stringify(value)}`,
		);
	}
	return await writeImageChannel(parsed.data, configPath);
}

export async function unsetImageChannel(configPath: string = getKanbanGlobalConfigPath()): Promise<ImageChannelChange> {
	return await writeImageChannel(null, configPath);
}
