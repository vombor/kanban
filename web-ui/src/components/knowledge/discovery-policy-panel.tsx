import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSourcePolicy } from "@/hooks/use-source-policy";

export function DiscoveryPolicyPanel({ workspaceId, onChanged }: { workspaceId: string; onChanged: () => void }) {
	const view = useSourcePolicy(workspaceId, onChanged),
		data = view.query.data;
	const [shared, setShared] = useState<string[] | null>(null),
		[folder, setFolder] = useState<string | null>(null),
		[id, setId] = useState(""),
		[title, setTitle] = useState(""),
		[vault, setVault] = useState("");
	if (view.query.isError)
		return (
			<p className="text-xs text-text-secondary">
				Source configuration is user-only or unavailable. Scoped discovery can still use permitted Markdown; no
				agent can change grants.
			</p>
		);
	if (!data) return <p>Reading user-owned source policy…</p>;
	return (
		<div className="space-y-3 rounded-md border border-border p-3 text-sm">
			<p className="text-text-secondary">
				User-only configuration. Shared Markdown folders live under the configured Kanban home at{" "}
				<code>data/knowledge-collections/shared/&lt;id&gt;</code>. Add files there yourself; this never writes notes
				or imports a vault.
			</p>
			{data.collections.map((collection) => (
				<label className="flex items-center gap-2" key={collection.id}>
					<input
						type="checkbox"
						checked={(shared ?? data.shared).includes(collection.id)}
						disabled={view.busy}
						onChange={(event) =>
							setShared(
								event.currentTarget.checked
									? [...(shared ?? data.shared), collection.id]
									: (shared ?? data.shared).filter((id) => id !== collection.id),
							)
						}
					/>
					{collection.title} · {collection.id}
				</label>
			))}
			<label className="block text-xs text-text-secondary">
				Optional private Obsidian folder
				<input
					aria-label="Optional private Obsidian folder"
					className="mt-1 w-full rounded-md border border-border-bright bg-surface-2 p-2"
					value={folder ?? data.obsidianFolder ?? ""}
					onChange={(event) => setFolder(event.currentTarget.value)}
					disabled={view.busy}
				/>
			</label>
			<Button
				size="sm"
				disabled={view.busy}
				onClick={() => {
					void view.save((client) =>
						client.savePolicy.mutate({
							globalRevision: data.globalRevision,
							projectRevision: data.projectRevision,
							shared: shared ?? data.shared,
							obsidianFolder: (folder ?? data.obsidianFolder)?.trim() || null,
						}),
					);
				}}
			>
				Save project source opt-ins
			</Button>
			<details>
				<summary className="cursor-pointer">Define a read-only Shared collection</summary>
				<div className="mt-2 space-y-2">
					<label className="block text-xs">
						Collection id
						<input
							aria-label="Shared collection id"
							value={id}
							onChange={(event) => setId(event.currentTarget.value)}
							maxLength={64}
							className="block w-full rounded-md border border-border-bright bg-surface-2 p-2"
						/>
					</label>
					<label className="block text-xs">
						Collection title
						<input
							aria-label="Shared collection title"
							value={title}
							onChange={(event) => setTitle(event.currentTarget.value)}
							maxLength={80}
							className="block w-full rounded-md border border-border-bright bg-surface-2 p-2"
						/>
					</label>
					<label className="block text-xs">
						Optional Shared Obsidian folder
						<input
							aria-label="Optional Shared Obsidian folder"
							value={vault}
							onChange={(event) => setVault(event.currentTarget.value)}
							maxLength={512}
							className="block w-full rounded-md border border-border-bright bg-surface-2 p-2"
						/>
					</label>
					<Button
						size="sm"
						disabled={view.busy || !id.trim() || !title.trim()}
						onClick={() => {
							void view.save((client) =>
								client.saveCollection.mutate({
									globalRevision: data.globalRevision,
									collection: { id: id.trim(), title: title.trim(), obsidianFolder: vault.trim() || null },
								}),
							);
						}}
					>
						Create Shared collection definition
					</Button>
				</div>
			</details>
			{view.error ? (
				<p role="alert" className="text-status-red">
					{view.error}
				</p>
			) : null}
			<Button
				size="sm"
				variant="ghost"
				disabled={view.busy}
				onClick={() => {
					setShared(null);
					setFolder(null);
					view.reload();
				}}
			>
				Reload source policy
			</Button>
		</div>
	);
}
