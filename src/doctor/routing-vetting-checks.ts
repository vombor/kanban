// Doctor rows for every registered project's routing against the vetted model registry (src/kits/routing-vetting.ts):
// each combination its kit routes work to (roles, QA routes, the fallback, runoff models) that the registry refuses
// for the role is a warning with the `kanban models vet` command; a project whose routes are all allowed gets one
// pass row, a `default`-kit project (routes nothing) an info row. Never fixed by --fix: the registry changes only
// through the Kanban repo, and a project's role models through `kanban kit set`.
import type { PipelineConfig } from "../config/pipeline-config";
import { DEFAULT_KIT_NAME, type KitCatalog, resolveWorkspaceKit } from "../kits/resolve-kit";
import { checkKitRoutes, getWorkspaceRoutingVetting } from "../kits/routing-vetting";
import { describeCombination, getVettedRegistry, type VettedRegistry } from "../models/vetted-registry";
import type { DoctorFinding } from "./doctor-report";

export interface RoutingVettingCheckContext {
	config: PipelineConfig;
	catalog: KitCatalog;
	entries: ReadonlyArray<{ workspaceId: string }>;
	/** Test hook: the registry (default the bundled one). */
	registry?: VettedRegistry;
}

export function checkRoutingVetting(context: RoutingVettingCheckContext): DoctorFinding[] {
	let registry: VettedRegistry;
	try {
		registry = context.registry ?? getVettedRegistry();
	} catch (error) {
		return [
			{
				level: "fail",
				area: "project",
				message: `the vetted model registry of this build doesn't load: ${error instanceof Error ? error.message : String(error)}`,
				hint: "fix models/vetted.json in the Kanban repo and rebuild",
			},
		];
	}
	const findings: DoctorFinding[] = [];
	for (const { workspaceId } of context.entries) {
		const resolution = resolveWorkspaceKit(context.config, workspaceId, context.catalog);
		if (resolution.kitName === DEFAULT_KIT_NAME) {
			findings.push({
				level: "info",
				area: "project",
				message: `${workspaceId}: kit default routes nothing (every card runs on the agent selected in Kanban settings), so the vetted model registry has nothing to check`,
			});
			continue;
		}
		const vetting = getWorkspaceRoutingVetting(context.config, workspaceId, registry);
		const routes = checkKitRoutes(resolution.kit, vetting);
		const refused = routes.filter((route) => !route.check.ok);
		for (const route of refused) {
			if (route.check.ok) {
				continue;
			}
			findings.push({
				level: "warn",
				area: "project",
				message: `${workspaceId}: kit ${resolution.kitName} ${route.label} → ${route.check.message}`,
				hint:
					route.check.verdict.status === "rejected"
						? `kanban kit set roles.<role>.model <a vetted model> --project ${workspaceId} (kanban models list --project ${workspaceId})`
						: route.check.vetCommand,
			});
		}
		if (refused.length === 0) {
			const described = routes.map(
				(route) => `${route.label} ${describeCombination(route.combination)} (${route.check.verdict.status})`,
			);
			findings.push({
				level: "pass",
				area: "project",
				message: `${workspaceId}: kit ${resolution.kitName} routes only to combinations the vetted model registry allows${vetting.allowProvisional ? " (provisional allowed)" : ""}: ${described.join("; ") || "none"}`,
			});
		}
	}
	return findings;
}
