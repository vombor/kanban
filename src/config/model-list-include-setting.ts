// `kanban config set|unset models.lists.lemonade.include`: the user's one command for which Lemonade models Cline's
// lemonade provider offers (2026-10-12; the models stay installed on Lemonade). Deliberately narrow: config.json has
// no general setter, and this one takes only that key. The write goes through updatePipelineConfigFile (config lock,
// atomic, every other key kept). The model-lists route reads config.json on every request, so Cline sees the new list
// on its next fetch; Cline's models.json changes only with `kanban setup-provider lemonade`, which the result names.
import { getKanbanGlobalConfigPath } from "../state/kanban-home";
import { LEMONADE_MODEL_LIST_INCLUDE_KEY, modelListIncludeSchema } from "./model-lists-config";
import { updatePipelineConfigFile } from "./pipeline-config";

export const CONFIG_SETTABLE_KEYS = [LEMONADE_MODEL_LIST_INCLUDE_KEY] as const;

export interface ModelListIncludeChange {
	key: string;
	from: unknown;
	to: string[] | null;
	configPath: string;
	/** What runs next so Cline's models.json follows. */
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
		next: "Kanban's model list for Cline follows now; run `kanban setup-provider lemonade` to update Cline's models.json too.",
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
