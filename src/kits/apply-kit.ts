// `kanban kit apply`: points a workspace at a kit (`workspaces.<id>.kit.name`), keeps its existing overrides,
// edits them with `--set`/`--unset`, and with `--landing` also sets the core landing mode. Applying a kit never
// changes the landing mode on its own (§4.2). The new resolution is validated before anything is written, so an
// unknown override key or a tier without a usable model is refused here, not discovered by the pipeline.
import {
	getWorkspacePipelineSettings,
	type LandingMode,
	readPipelineConfig,
	updateWorkspacePipelineEntry,
} from "../config/pipeline-config";
import { DEFAULT_KIT_NAME, loadKitCatalog, readKitValue, resolveKitByName, resolveWorkspaceKit } from "./resolve-kit";

export interface ApplyKitInput {
	workspaceId: string;
	kitName: string;
	landing?: LandingMode;
	set?: Record<string, unknown>;
	unset?: string[];
	dryRun?: boolean;
	configPath?: string;
	kitsDir?: string;
}

export interface KitValueChange {
	key: string;
	from: unknown;
	to: unknown;
	fromSource: string | null;
	toSource: string | null;
}

export interface ApplyKitResult {
	workspaceId: string;
	kitName: { from: string; to: string };
	landing: { from: LandingMode; to: LandingMode };
	overrides: Record<string, unknown>;
	changes: KitValueChange[];
	recommendedLandingMode: LandingMode | null;
	/** Issues with the workspace's current kit (it fell back to `default`). */
	previousIssues: string[];
	written: boolean;
}

function isObject(value: unknown): boolean {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function applyWorkspaceKit(input: ApplyKitInput): Promise<ApplyKitResult> {
	const [{ config }, catalog] = await Promise.all([
		readPipelineConfig(input.configPath),
		loadKitCatalog(input.kitsDir),
	]);
	const settings = getWorkspacePipelineSettings(config, input.workspaceId);
	const before = resolveWorkspaceKit(config, input.workspaceId, catalog);
	const overrides: Record<string, unknown> = { ...(settings.kit?.overrides ?? {}) };
	for (const key of input.unset ?? []) {
		if (!Object.hasOwn(overrides, key)) {
			throw new Error(`--unset ${key}: the workspace has no override for ${key}.`);
		}
		delete overrides[key];
	}
	Object.assign(overrides, input.set ?? {});
	const after = resolveKitByName(catalog, input.kitName, overrides);
	if (!after.ok) {
		throw new Error(`Kit ${input.kitName} does not resolve for ${input.workspaceId}: ${after.error}`);
	}
	const keys = new Set([...Object.keys(before.sources), ...Object.keys(after.sources)]);
	const changes: KitValueChange[] = [];
	for (const key of [...keys].sort()) {
		const from = readKitValue(before.kit, key);
		const to = readKitValue(after.kit, key);
		const fromSource = before.sources[key] ?? null;
		const toSource = after.sources[key] ?? null;
		// A key that is a leaf on one side only (`qa.rules: {}` vs `qa.rules.drive`): its leaves show the change.
		const interiorOnOneSide = (fromSource === null && isObject(from)) || (toSource === null && isObject(to));
		if (!interiorOnOneSide && (JSON.stringify(from) !== JSON.stringify(to) || fromSource !== toSource)) {
			changes.push({ key, from, to, fromSource, toSource });
		}
	}
	const landing = { from: settings.landing.mode, to: input.landing ?? settings.landing.mode };
	const result: ApplyKitResult = {
		workspaceId: input.workspaceId,
		kitName: { from: before.kitName, to: input.kitName },
		landing,
		overrides,
		changes,
		recommendedLandingMode: after.kit.recommends?.landingMode ?? null,
		previousIssues: before.issues,
		written: false,
	};
	if (input.dryRun) {
		return result;
	}
	await updateWorkspacePipelineEntry(
		input.workspaceId,
		(entry) => {
			const currentKit = entry.kit && typeof entry.kit === "object" ? (entry.kit as { overrides?: unknown }) : null;
			if (JSON.stringify(currentKit?.overrides ?? {}) !== JSON.stringify(settings.kit?.overrides ?? {})) {
				throw new Error(`workspaces.${input.workspaceId}.kit changed while applying; run the command again.`);
			}
			// No kit entry means `default`, so `default` without overrides is written as no entry.
			if (input.kitName === DEFAULT_KIT_NAME && Object.keys(overrides).length === 0) {
				delete entry.kit;
			} else {
				entry.kit = { name: input.kitName, overrides };
			}
			if (input.landing) {
				const current = entry.landing && typeof entry.landing === "object" ? entry.landing : {};
				entry.landing = { ...current, mode: input.landing };
			}
			return entry;
		},
		input.configPath,
	);
	return { ...result, written: true };
}
