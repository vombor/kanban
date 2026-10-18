import { createHash } from "node:crypto";
import { type CoordinationTask, coordinationReportSchema } from "../trpc/coordination-contract";

function overlaps(a: string, b: string) {
	return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
export function buildCoordinationReport(input: {
	tasks: CoordinationTask[];
	dependencies: Array<{ waiting: string; prerequisite: string; basis: "board" | "approved_plan" }>;
	planTaskId: string | null;
	approvedBundle: string | null;
	now: number;
	truncated: boolean;
	warnings: string[];
	capacity: Record<string, { maxLoadedModels: number }>;
	concurrency: Record<string, number>;
}) {
	const advice: Array<{
		kind: "path_overlap" | "contract_dependency" | "provider_serialization";
		tasks: [string, string];
		details: string[];
		basis: "reviewed_hints" | "retained_snapshots" | "mixed" | "configured_capacity";
	}> = [];
	let truncated = input.truncated;
	for (let i = 0; i < input.tasks.length; i++)
		for (const b of input.tasks.slice(i + 1)) {
			const a = input.tasks[i];
			if (!a || a.state === "trash" || b.state === "trash") continue;
			const add = (value: (typeof advice)[number]) => {
				if (advice.length < 200) advice.push(value);
				else truncated = true;
			};
			const hintsA = a.hints?.paths ?? [],
				hintsB = b.hints?.paths ?? [];
			const paths = [
				...new Set(
					[...hintsA, ...a.observedPaths].filter((p) =>
						[...hintsB, ...b.observedPaths].some((q) => overlaps(p, q)),
					),
				),
			];
			if (paths.length > 10) truncated = true;
			if (paths.length)
				add({
					kind: "path_overlap",
					tasks: [a.id, b.id],
					details: paths.slice(0, 10),
					basis:
						a.observedPaths.length || b.observedPaths.length
							? hintsA.length || hintsB.length
								? "mixed"
								: "retained_snapshots"
							: "reviewed_hints",
				});
			const contracts = [
				...(a.hints?.produces ?? [])
					.filter((p) => b.hints?.consumes.includes(p))
					.map((p) => `${a.id} produces ${p}`),
				...(b.hints?.produces ?? [])
					.filter((p) => a.hints?.consumes.includes(p))
					.map((p) => `${b.id} produces ${p}`),
			];
			if (contracts.length > 10) truncated = true;
			if (contracts.length)
				add({
					kind: "contract_dependency",
					tasks: [a.id, b.id],
					details: contracts.slice(0, 10),
					basis: "reviewed_hints",
				});
			const provider = a.model?.provider;
			if (
				provider &&
				provider === b.model?.provider &&
				(input.concurrency[provider] === 1 ||
					(input.capacity[provider]?.maxLoadedModels === 1 && a.model?.model !== b.model?.model))
			)
				add({
					kind: "provider_serialization",
					tasks: [a.id, b.id],
					details: [
						`${provider}: one ${input.concurrency[provider] === 1 ? "request" : "model"} at a time; sequence through existing admission, not a new dependency`,
					],
					basis: "configured_capacity",
				});
		}
	const evidence = {
		planTaskId: input.planTaskId,
		approvedBundle: input.approvedBundle,
		tasks: input.tasks,
		dependencies: input.dependencies,
		advice,
		capacity: input.capacity,
		concurrency: input.concurrency,
	};
	return coordinationReportSchema.parse({
		planTaskId: input.planTaskId,
		approvedBundle: input.approvedBundle,
		tasks: input.tasks,
		dependencies: input.dependencies,
		advice,
		fingerprint: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
		generatedAt: input.now,
		truncated,
		warnings: input.warnings,
		authority: "advisory_only_not_start_assignment_dependency_qa_or_landing_authority",
	});
}
