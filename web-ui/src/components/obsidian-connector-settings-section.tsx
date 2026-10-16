import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useObsidianConnector } from "@/hooks/use-obsidian-connector";

const INPUT = "h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary";

export function ObsidianConnectorSettingsSection({ active }: { active: boolean }): React.ReactElement {
	const draft = useObsidianConnector(active);
	const disabled = draft.busy || !draft.loaded;
	return (
		<section
			aria-label="Obsidian knowledge connector"
			className="mb-4 space-y-3 rounded-lg border border-border bg-surface-0 px-4 py-3"
		>
			<h3 className="m-0 text-[13px] font-semibold text-text-primary">Obsidian REST API (optional)</h3>
			<p className="m-0 text-[13px] text-text-secondary">
				Connect an app-level Obsidian knowledge graph without installing an embedding or vector service. Connection
				settings apply to the installation, not just this project.
			</p>
			<label className="flex items-center gap-2 text-[13px] text-text-primary">
				<input
					type="checkbox"
					checked={draft.settings.enabled}
					disabled={disabled}
					onChange={(event) => draft.update({ enabled: event.target.checked })}
				/>
				Enable Obsidian connector
			</label>
			<label className="flex flex-col gap-1 text-xs text-text-secondary">
				REST API endpoint
				<input
					aria-label="Obsidian REST API endpoint"
					className={INPUT}
					value={draft.settings.baseUrl}
					disabled={disabled}
					placeholder="https://obsidian.example:27124"
					onChange={(event) => draft.update({ baseUrl: event.target.value })}
					autoComplete="off"
				/>
			</label>
			<p className="m-0 text-xs text-text-tertiary">
				Use an address reachable from the Kanban server. Localhost inside a container is not the host machine.
			</p>
			{/^http:/iu.test(draft.settings.baseUrl) ? (
				<p className="m-0 text-xs text-status-orange">
					HTTP sends the API key without transport encryption. Use only on a network you trust; prefer HTTPS with
					the plugin's CA.
				</p>
			) : null}
			<label className="flex flex-col gap-1 text-xs text-text-secondary">
				API key {draft.configured ? "(stored; leave empty to keep)" : "(not configured)"}
				<input
					aria-label="Obsidian API key"
					type="password"
					autoComplete="new-password"
					className={INPUT}
					value={draft.key}
					disabled={disabled || draft.removeKey}
					onChange={(event) => draft.setKey(event.target.value)}
				/>
			</label>
			{draft.configured ? (
				<label className="flex items-center gap-2 text-xs text-text-secondary">
					<input
						type="checkbox"
						checked={draft.removeKey}
						disabled={disabled}
						onChange={(event) => {
							draft.setRemoveKey(event.target.checked);
							draft.setKey("");
						}}
					/>
					Remove stored API key (disable the connector first)
				</label>
			) : null}
			<label className="flex flex-col gap-1 text-xs text-text-secondary">
				CA certificate (optional PEM)
				<textarea
					aria-label="Obsidian CA certificate"
					rows={3}
					className={`${INPUT} h-auto py-2 font-mono text-xs`}
					value={draft.settings.caCertificate}
					disabled={disabled}
					onChange={(event) => draft.update({ caCertificate: event.target.value })}
				/>
			</label>
			<p className="m-0 text-xs text-text-tertiary">
				TLS verification stays enabled. The key is kept in the server's private secrets directory and is never
				returned to agents or saved-value fields.
			</p>
			<div className="flex items-center gap-2">
				<Button type="button" size="sm" onClick={() => void draft.test()} disabled={disabled}>
					Test connection
				</Button>
				<Button type="button" size="sm" variant="primary" onClick={() => void draft.save()} disabled={disabled}>
					Save connector
				</Button>
				{draft.busy ? <Spinner size={14} /> : null}
			</div>
			{draft.error ? (
				<p role="alert" className="m-0 text-[13px] text-status-red">
					{draft.error}
				</p>
			) : null}
			{draft.notice ? (
				<p role="status" className="m-0 text-[13px] text-status-green">
					{draft.notice}
				</p>
			) : null}
			{draft.probe ? (
				<div role="status" className="space-y-1 text-[13px] text-text-secondary">
					<p className={draft.probe.ok ? "m-0 text-status-green" : "m-0 text-status-red"}>{draft.probe.message}</p>
					{draft.probe.ok ? (
						<>
							<p className="m-0">REST API version: {draft.probe.version ?? "not reported"}</p>
							<p className="m-0">
								Native graph: {draft.probe.capabilities.graph ? "available" : "not advertised"} · Search:{" "}
								{draft.probe.capabilities.search ? "available" : "not advertised"} · Document maps:{" "}
								{draft.probe.capabilities.documentMap ? "available" : "not advertised"}
							</p>
							<p className="m-0">
								Indexing activity:{" "}
								{draft.probe.indexing === "quiet"
									? "quiet (not a completeness guarantee)"
									: draft.probe.indexing === "recent_activity"
										? "recent activity; graph may be incomplete"
										: "not reported"}
							</p>
						</>
					) : null}
				</div>
			) : null}
			<p className="m-0 text-xs text-text-tertiary">
				This configures and verifies the connection only. Scoped project/shared graph retrieval is the next
				knowledge-layer milestone; agents do not gain unrestricted vault access.
			</p>
		</section>
	);
}
