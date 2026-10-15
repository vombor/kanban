import { projectSecretsWriteSchema } from "@runtime-project-secrets";
import { useEffect, useState } from "react";
import { useProjectRename } from "@/hooks/use-project-rename";
import { replaceProjectShortcuts } from "@/runtime/runtime-config-query";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	ProjectSecretInput,
	ProjectSecretMetadata,
	RuntimeProjectShortcut,
	RuntimeProjectSummary,
} from "@/runtime/types";
import { useLatest } from "@/utils/react-use";

/** The user's draft, load cancellation and writes to each authoritative project setting store. */
export function useProjectDefinition(project: RuntimeProjectSummary | null, onSaved: () => void) {
	const { isSaving: isRenaming, error: nameError, clearError, rename } = useProjectRename();
	const [name, setName] = useState("");
	const [scripts, setScripts] = useState<RuntimeProjectShortcut[]>([]);
	const [secrets, setSecrets] = useState<ProjectSecretInput[]>([]);
	const [metadata, setMetadata] = useState<ProjectSecretMetadata[]>([]);
	const [removed, setRemoved] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const projectId = project?.id ?? null;
	const latestProject = useLatest(project);
	useEffect(() => {
		let active = true;
		setName(latestProject.current?.name ?? "");
		clearError();
		setSecrets([]);
		setRemoved([]);
		setScripts([]);
		setMetadata([]);
		setError(null);
		setLoadFailed(false);
		setLoading(projectId !== null);
		if (projectId) {
			const client = getRuntimeTrpcClient(projectId);
			void Promise.all([client.shortcuts.list.query(), client.projectSecrets.list.query()])
				.then(([config, response]) => {
					if (active) {
						setScripts(config.shortcuts);
						setMetadata(response.secrets);
					}
				})
				.catch(() => {
					if (active) {
						setError("Could not load the project's definition.");
						setLoadFailed(true);
					}
				})
				.finally(() => {
					if (active) setLoading(false);
				});
		}
		return () => {
			active = false;
		};
	}, [projectId, latestProject, clearError]);
	const submit = async () => {
		if (!projectId || loading || loadFailed || saving || isRenaming) return;
		if (!projectSecretsWriteSchema.safeParse({ secrets }).success) {
			setError(
				"Secrets need unique environment-variable names and values of 1–65,536 characters (at most 100 secrets).",
			);
			return;
		}
		setSaving(true);
		setError(null);
		try {
			// Validate/rename first, so a refused display name cannot accidentally change credentials.
			if (!(await rename(projectId, name))) return;
			await replaceProjectShortcuts(projectId, scripts);
			const client = getRuntimeTrpcClient(projectId);
			for (const secret of removed) {
				const response = await client.projectSecrets.remove.mutate({ name: secret });
				setMetadata(response.secrets);
				setRemoved((current) => current.filter((name) => name !== secret));
			}
			if (secrets.length) {
				const response = await client.projectSecrets.set.mutate({ secrets });
				setMetadata(response.secrets);
				setSecrets([]);
			}
			onSaved();
		} catch {
			setError("Could not finish saving the project. Changes already saved are kept; you can retry.");
		} finally {
			setSaving(false);
		}
	};
	return {
		name,
		setName,
		scripts,
		setScripts,
		secrets,
		setSecrets,
		metadata,
		removed,
		remove: (name: string) => setRemoved((current) => [...current, name]),
		loading,
		busy: loading || saving || isRenaming,
		saving: saving || isRenaming,
		loadFailed,
		error: error ?? nameError,
		clearError,
		submit,
	};
}
