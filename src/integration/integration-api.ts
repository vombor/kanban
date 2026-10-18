import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { removeTreeWithoutFollowingLinks } from "../fs/remove-tree";
import type { KitChecks } from "../kits/kit-schema";
import { authorizeKnowledgeCaller } from "../knowledge/knowledge-api";
import type { TaskContextStore } from "../knowledge/task-context-store";
import {
	type ChecksRequest,
	type ChecksResult,
	type ChecksSettings,
	checksSettingsFingerprint,
	checksToolchainFingerprint,
	readSnapshotCheckScripts,
	toStoredChecksResult,
} from "../pipeline/checks";
import { readChecksEnvFingerprint } from "../pipeline/checks-project-env";
import { getIntegrationReportPaths } from "../state/kanban-home";
import type { RuntimeCoordinationApi } from "../trpc/coordination-contract";
import {
	type IntegrationManifest,
	type IntegrationReport,
	integrationManifestSchema,
	integrationReportSchema,
	integrationSelectionSchema,
	type RuntimeIntegrationApi,
} from "../trpc/integration-contract";
import { buildIntegrationCandidate, integrationHash } from "./candidate";
import { IntegrationChecksUnavailableError } from "./checks-admission";
import { createIntegrationReportStore } from "./report-store";

export interface IntegrationSetup {
	repoPath: string;
	settings: ChecksSettings;
	scripts: string[];
	project: KitChecks | undefined;
	checksEnabled: boolean;
	alternateWorker: boolean;
	paused: boolean;
}
export function createIntegrationApi(deps: {
	coordination: RuntimeCoordinationApi;
	contexts: Pick<TaskContextStore, "read">;
	setup: (workspaceId: string) => Promise<IntegrationSetup>;
	checks: (request: ChecksRequest) => Promise<ChecksResult>;
	homePath?: string;
	store?: ReturnType<typeof createIntegrationReportStore>;
	candidate?: typeof buildIntegrationCandidate;
	now?: () => number;
	toolchain?: () => string;
}) {
	const store = deps.store ?? createIntegrationReportStore(deps.homePath),
		now = deps.now ?? Date.now,
		active = new Map<string, Promise<void>>();
	let closed = false;
	const key = (workspaceId: string, id: string) => JSON.stringify([workspaceId, id]);
	const manifest = async (
		caller: Parameters<RuntimeIntegrationApi["preview"]>[0],
		workspaceId: string,
		input: z.infer<typeof integrationSelectionSchema>,
	) => {
		authorizeKnowledgeCaller(caller, workspaceId);
		const selection = integrationSelectionSchema.parse({ ...input, taskIds: [...input.taskIds].sort() });
		const report = await deps.coordination.preview(caller, workspaceId, { planTaskId: selection.planTaskId }),
			setup = await deps.setup(workspaceId);
		if (report.truncated) throw new Error("Bounded sources incomplete");
		const members: IntegrationManifest["members"] = [];
		let baseCommit: string | null = null;
		for (const taskId of selection.taskIds) {
			const task = report.tasks.find((task) => task.taskId === taskId);
			if (
				!task?.snapshot ||
				!task.baseCommit ||
				task.state !== "review" ||
				!task.reviewSettled ||
				task.ownerStates.includes("session_running")
			)
				throw new Error("Selected task has no settled retained Review snapshot");
			if (baseCommit && baseCommit !== task.baseCommit)
				throw new Error("Selected tasks have different current bases");
			baseCommit = task.baseCommit;
			const context = await deps.contexts.read(workspaceId, taskId);
			if (selection.planTaskId && context && context.planTaskId !== selection.planTaskId)
				throw new Error("Task context belongs to a different approved plan");
			members.push({ taskId, snapshot: task.snapshot, contextRevision: context?.revision ?? null });
		}
		if (!baseCommit) throw new Error("Missing exact base");
		const envFingerprint = setup.project?.envFile
			? await readChecksEnvFingerprint(setup.repoPath, setup.project.envFile)
			: undefined;
		const scripts = setup.scripts.filter((name) => /^[A-Za-z0-9:_-]{1,80}$/u.test(name));
		if (scripts.length !== setup.scripts.length) throw new Error("Unsupported check script name");
		const definition = {
			version: 1 as const,
			sourceFingerprint: report.fingerprint,
			baseCommit,
			selection,
			members,
			checksFingerprint: integrationHash({
				workspaceId,
				repoPath: setup.repoPath,
				settings: setup.settings,
				scripts,
				project: setup.project ?? null,
				envFingerprint: envFingerprint ?? null,
				enabled: setup.checksEnabled,
				paused: setup.paused,
				alternateWorker: setup.alternateWorker,
			}),
			toolchainFingerprint: (deps.toolchain ?? checksToolchainFingerprint)(),
			scripts,
			warnings: [
				"speculative_combination_not_individual_qa_acceptance",
				"unsubmitted_work_and_unknown_environment_changes_not_certified",
				...(members.some((m) => !m.contextRevision) ? ["some_tasks_have_no_retained_immutable_context"] : []),
				...(!setup.checksEnabled ? ["project_checks_disabled_no_check_pass_can_be_reported"] : []),
			],
			authority: "speculative_report_not_qa_or_landing_approval" as const,
		};
		return {
			manifest: integrationManifestSchema.parse({ ...definition, fingerprint: integrationHash(definition) }),
			setup,
			envFingerprint,
		};
	};
	const fresh = async (
		caller: Parameters<RuntimeIntegrationApi["read"]>[0],
		workspaceId: string,
		report: IntegrationReport,
	): Promise<IntegrationReport> => {
		let freshness: IntegrationReport["freshness"] = "unknown";
		try {
			freshness =
				(await manifest(caller, workspaceId, report.manifest.selection)).manifest.fingerprint ===
				report.manifest.fingerprint
					? "current"
					: "stale";
		} catch {
			/* Unknown never means current. */
		}
		if ((report.status === "reserved" || report.status === "running") && !active.has(key(workspaceId, report.id)))
			return { ...report, status: "uncertain", reason: "retained_execution_outcome_unknown_no_replay", freshness };
		return { ...report, freshness };
	};
	const execute = async (
		workspaceId: string,
		initial: IntegrationReport,
		setup: IntegrationSetup,
		envFingerprint: string | undefined,
	) => {
		const candidatePath = join(getIntegrationReportPaths(workspaceId, deps.homePath).candidates, initial.id);
		let report = { ...initial, status: "running" as IntegrationReport["status"] },
			keep = false,
			owned = false;
		const save = async () => {
			await store.update(workspaceId, (reports) => reports.map((item) => (item.id === report.id ? report : item)));
		};
		try {
			if (closed) throw new Error("Closing before candidate execution");
			await save();
			const candidate = await (deps.candidate ?? buildIntegrationCandidate)(
				setup.repoPath,
				candidatePath,
				initial.manifest,
				() => {
					owned = true;
				},
			);
			report = { ...report, ...candidate, cleanup: "retained_uncertain" };
			if (candidate.conflictTaskId) report.status = "conflicts";
			else if (!candidate.candidateCommit || !setup.checksEnabled || setup.paused || setup.alternateWorker) {
				report.status = "unavailable";
				report.reason = "existing_checks_disabled_paused_or_alternate_worker_no_checks_executed";
			} else {
				const scripts = await readSnapshotCheckScripts(
					candidatePath,
					candidate.candidateCommit,
					initial.manifest.scripts,
				);
				if (scripts.length !== initial.manifest.scripts.length || !scripts.length) {
					report.status = "unavailable";
					report.reason = "required_scripts_missing_or_no_scripts_no_pass_claimed";
				} else {
					keep = true;
					await save();
					const result = await deps.checks({
						workspaceId,
						taskId: `integration_${initial.id.replaceAll("-", "")}`,
						integrationReportId: initial.id,
						title: "Speculative integration report",
						repoPath: candidatePath,
						baseRef: initial.manifest.baseCommit,
						snapshot: candidate.candidateCommit,
						scripts,
						project: setup.project,
						worktreePath: setup.repoPath,
						checksSettingsFingerprint: checksSettingsFingerprint(setup.settings),
						expectedToolchainFingerprint: initial.manifest.toolchainFingerprint,
						expectedEnvFingerprint: envFingerprint,
						expectedProjectChecksFingerprint: checksSettingsFingerprint({
							project: setup.project ?? null,
							scripts: setup.scripts,
							enabled: setup.checksEnabled,
						}),
					});
					if (
						result.request.integrationReportId !== initial.id ||
						result.request.snapshot !== candidate.candidateCommit
					)
						throw new Error("Mismatched result");
					keep = false;
					const stored = toStoredChecksResult(result);
					report.steps = stored.steps.slice(0, 100).map((step, index) => ({
						name: step.name.slice(0, 160),
						status: step.status,
						harness: step.harness,
						advisory: result.steps[index]?.advisory === true,
					}));
					report.status =
						result.verdict === "PASS" &&
						!result.harness &&
						result.error === null &&
						result.steps.every(
							(step) => step.advisory || (step.ok && !step.skipped && !step.timedOut && !step.harness),
						) &&
						stored.steps.length <= 100 &&
						scripts.every((name) =>
							stored.steps.some((step) => step.name === name && step.status === "ok" && !step.harness),
						)
							? "checks_passed"
							: result.verdict === "FAIL" && !result.harness
								? "checks_failed"
								: "unavailable";
					if (report.status === "unavailable")
						report.reason = "checks_unavailable_incomplete_or_harness_failure_not_qa_acceptance";
				}
			}
		} catch (error) {
			if (error instanceof IntegrationChecksUnavailableError) keep = false;
			report.status = keep ? "uncertain" : "unavailable";
			report.reason =
				error instanceof IntegrationChecksUnavailableError
					? "shared_checks_unavailable_before_submission"
					: keep
						? "checks_outcome_uncertain_no_replay"
						: "candidate_preparation_unavailable_no_checks_pass_claimed";
		} finally {
			if (!owned) {
				report.cleanup = "not_created";
			} else if (keep) report.cleanup = "retained_uncertain";
			else {
				try {
					await removeTreeWithoutFollowingLinks(candidatePath);
					report.cleanup = "complete";
				} catch {
					report.cleanup = "retained_uncertain";
					report.status = "uncertain";
					report.reason = "candidate_cleanup_unconfirmed_no_replay";
				}
			}
			report.finishedAt = now();
			report.freshness = "unknown";
			await save();
		}
	};
	const api: RuntimeIntegrationApi = {
		list: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			try {
				const reports = [...(await store.read(workspaceId)).reports].reverse();
				return {
					reports: reports.slice(input.offset, input.offset + 20).map((report) => ({
						id: report.id,
						status:
							(report.status === "running" || report.status === "reserved") &&
							!active.has(key(workspaceId, report.id))
								? ("uncertain" as const)
								: report.status,
						createdAt: report.createdAt,
					})),
					nextOffset: input.offset + 20 < reports.length ? input.offset + 20 : null,
				};
			} catch {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Retained integration history unavailable; no history was reset.",
				});
			}
		},
		preview: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			try {
				return (await manifest(caller, workspaceId, input)).manifest;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Exact retained Review snapshots/context/check configuration are unavailable; no mutable fallback was used.",
				});
			}
		},
		run: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			if (caller.kind !== "user")
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only the user may explicitly execute project code for integration reports.",
				});
			try {
				if (closed) throw new Error("Closing");
				const existing = (await store.read(workspaceId)).reports.find((r) => r.id === input.requestId);
				if (existing) {
					if (existing.manifest.fingerprint !== input.fingerprint) throw new TRPCError({ code: "CONFLICT" });
					return fresh(caller, workspaceId, existing);
				}
				const selection = { taskIds: input.taskIds, ...(input.planTaskId ? { planTaskId: input.planTaskId } : {}) };
				const prepared = await manifest(caller, workspaceId, selection);
				if (prepared.manifest.fingerprint !== input.fingerprint)
					throw new TRPCError({
						code: "CONFLICT",
						message: "Exact candidate changed; preview again before explicitly running it.",
					});
				const initial = integrationReportSchema.parse({
					id: input.requestId,
					manifest: prepared.manifest,
					status: "reserved",
					createdAt: now(),
					finishedAt: null,
					candidateCommit: null,
					candidateTree: null,
					conflictTaskId: null,
					steps: [],
					reason: null,
					cleanup: "not_created",
					freshness: "current",
					authority: "speculative_report_not_qa_or_landing_approval",
				});
				let created = false;
				const state = await store.update(workspaceId, (reports) => {
					const duplicate = reports.find((r) => r.id === input.requestId);
					if (duplicate) {
						if (duplicate.manifest.fingerprint !== input.fingerprint) throw new TRPCError({ code: "CONFLICT" });
						return reports;
					}
					if (reports.some((r) => r.status === "reserved" || r.status === "running" || r.status === "uncertain"))
						throw new TRPCError({
							code: "PRECONDITION_FAILED",
							message:
								"An integration execution is active or uncertain; inspect its retained report rather than replaying code.",
						});
					created = true;
					return [...reports, initial];
				});
				if (created) {
					const promise = execute(workspaceId, initial, prepared.setup, prepared.envFingerprint)
						.catch(() => {})
						.finally(() => active.delete(key(workspaceId, initial.id)));
					active.set(key(workspaceId, initial.id), promise);
				}
				return state.reports.find((r) => r.id === initial.id) ?? initial;
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"Integration submission could not be confirmed; retain the request id and read its report. No automatic retry or acceptance was performed.",
				});
			}
		},
		read: async (caller, workspaceId, input) => {
			authorizeKnowledgeCaller(caller, workspaceId);
			try {
				const report = (await store.read(workspaceId)).reports.find((r) => r.id === input.id);
				if (!report) throw new TRPCError({ code: "NOT_FOUND" });
				return await fresh(caller, workspaceId, report);
			} catch (error) {
				if (error instanceof TRPCError) throw error;
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Retained integration report unavailable; no history was reset.",
				});
			}
		},
	};
	return {
		api,
		close: () => {
			closed = true;
		},
		idle: async () => {
			await Promise.allSettled(active.values());
		},
	};
}
