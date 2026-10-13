// `kanban config set|unset models.lists.lemonade.include`: the user's one command for which Lemonade models Kanban's
// model-lists route lists (2026-10-12; the models stay installed on Lemonade). Deliberately narrow: config.json has
// no general setter, and this one takes only that key. The write goes through updatePipelineConfigFile (config lock,
// atomic, every other key kept). The model-lists route reads config.json on every request. Cline's lemonade provider
// is not pointed at that route: what Cline offers is the models record in its models.json, curated by the user
// (docs/team/MODELS.md), which this setting never changes.
import { getKanbanGlobalConfigPath } from "../state/kanban-home";
import { LEMONADE_MODEL_LIST_INCLUDE_KEY, modelListIncludeSchema } from "./model-lists-config";
import { updatePipelineConfigFile } from "./pipeline-config";

export const CONFIG_SETTABLE_KEYS = [LEMONADE_MODEL_LIST_INCLUDE_KEY] as const;

export interface ModelListIncludeChange {
	key: string;
	from: unknown;
	to: string[] | null;
	configPath: string;
	/** What the change does and doesn't reach. */
	next: string;
}

function assertKey(key: string): void {
	if (!(CONFIG_SETTABLE_KEYS as readonly string[]).includes(key)) {
		throw new Error(`only ${CONFIG_SETTABLE_KEYS.join(", ")} can be set here, not ${JSON.stringify(key)}`);
	}
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

async function writeInclude(include: string[] | null, configPath: string): Promise<ModelListIncludeChange> {
	let from: unknown;
	await updatePipelineConfigFile((config) => {
		const models = asObject(config.models);
		const lists = asObject(models.lists);
		const lemonade = asObject(lists.lemonade);
		from = lemonade.include;
		if (include === null) {
			delete lemonade.include;
		} else {
			lemonade.include = include;
		}
		lists.lemonade = lemonade;
		models.lists = lists;
		return { ...config, models };
	}, configPath);
	return {
		key: LEMONADE_MODEL_LIST_INCLUDE_KEY,
		from,
		to: include,
		configPath,
		next: "Kanban's model-lists route follows now. What Cline offers is the lemonade models record in Cline's models.json, which the user curates; this doesn't change it.",
	};
}

export async function setModelListInclude(
	key: string,
	values: readonly string[],
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ModelListIncludeChange> {
	assertKey(key);
	const parsed = modelListIncludeSchema.safeParse(values);
	if (!parsed.success || !parsed.data) {
		throw new Error(`${key} needs at least one model id; \`kanban config unset ${key}\` offers every model again`);
	}
	return await writeInclude([...new Set(parsed.data)], configPath);
}

export async function unsetModelListInclude(
	key: string,
	configPath: string = getKanbanGlobalConfigPath(),
): Promise<ModelListIncludeChange> {
	assertKey(key);
	return await writeInclude(null, configPath);
}
