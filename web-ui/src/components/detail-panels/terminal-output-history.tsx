import { History } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useTerminalOutputHistory } from "@/terminal/use-terminal-output-history";
import { stripAnsi } from "../../../../src/terminal/output-utils";

export function TerminalOutputHistory({ workspaceId, taskId }: { workspaceId: string; taskId: string }) {
	const [open, setOpen] = useState(false);
	const history = useTerminalOutputHistory(workspaceId, taskId, open);
	return (
		<>
			<div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1 text-xs text-text-secondary">
				<span title="Initial replay is at most 200 scrollback lines and 128 KiB. Older output is read only on demand; agent context is unchanged.">
					Recent output only
				</span>
				<Button
					variant="ghost"
					size="sm"
					icon={<History size={14} />}
					onClick={() => {
						history.newest();
						setOpen(true);
					}}
				>
					Output history
				</Button>
			</div>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogHeader title="Terminal output history" />
				<DialogBody>
					<p className="text-xs text-text-secondary">
						One page at a time: up to 64 KiB / 500 lines. This does not send input or replay old commands into the
						agent. Archives begin with launches made on the updated runtime; earlier agent-owned logs remain
						unchanged.
					</p>
					{history.loading ? (
						<Spinner size={16} />
					) : history.error ? (
						<p role="alert" className="text-status-red">
							Could not read terminal history.
						</p>
					) : history.value?.available ? (
						<>
							<p className="text-xs text-text-secondary">
								Bytes {history.value.start}–{history.value.end} of {history.value.totalBytes}
							</p>
							{history.value.recordingError ? (
								<p role="alert" className="text-status-orange">
									Recording encountered a storage error; this archive may be incomplete. The agent was not
									stopped.
								</p>
							) : null}
							<pre
								data-testid="terminal-history-page"
								className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-0 p-3 text-xs text-text-primary"
							>
								{stripAnsi(history.value.text)}
							</pre>
						</>
					) : (
						<p className="text-text-secondary">No archived terminal output is available yet.</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button size="sm" onClick={history.older} disabled={history.loading || !history.value?.start}>
						Older output
					</Button>
					<Button size="sm" onClick={history.newer} disabled={history.loading || !history.canGoNewer}>
						Newer output
					</Button>
					<Button size="sm" onClick={history.newest} disabled={history.loading}>
						Newest
					</Button>
					<Button size="sm" onClick={() => setOpen(false)}>
						Close
					</Button>
				</DialogFooter>
			</Dialog>
		</>
	);
}
