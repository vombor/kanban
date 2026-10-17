# Bounded terminal display and output history

Opening a card restores only a recent terminal tail: at most **200 scrollback rows and 128 KiB**. The server applies
the byte limit before transferring the snapshot. Live display keeps at most 1,000 scrollback rows, receives frames
in 16 KiB pieces and yields while replaying/processing bursts so navigation can remain responsive.

Closing a panel or hiding its mobile Chat tab disconnects that viewer; it does **not** stop the agent. At most five
idle browser terminal instances are cached. Reopening obtains a fresh bounded restore. A viewer that cannot drain
its bounded write queue reconnects/restores instead of accumulating unlimited output. Other viewers keep their own
connections and acknowledgements; warm control-only reconnects still preserve committed output.

**Output history** reads one page at a time: at most **64 KiB / 500 lines**. Older/Newer/Newest replace the displayed
page instead of appending every page to the DOM. Old control sequences are shown as text with styling removed; they
are never executed in the live terminal and the history viewer sends no agent input.

New runtime launches append their terminal output to private files under
`<Kanban home>/data/<workspace>/terminal-output/<hashed-task-id>.log`, mode 0600. These archives remain across session
restarts and task Done/worktree cleanup. Readback is workspace-scoped and filenames are not caller paths. Storage
failures are reported without stopping an agent; the history viewer warns when recording encountered an error.
The display limit never truncates these files, agent-owned transcripts, model context, evidence or task work.

Archives begin with launches made on a runtime containing this feature. They cannot recreate raw PTY output that
older versions never stored. Existing agent-owned session logs are retained unchanged. Terminal archives may contain
sensitive output: keep them private and do not attach entire archives to public issues. Project removal/reset still
follows the user's ordinary explicit data-removal workflow; this feature introduces no automatic retention purge.

The safeguards address bounded-output responsiveness; they do not claim that cumulative token totals caused a
reported UI freeze or that every earlier unreproduced renderer issue has the same cause.
