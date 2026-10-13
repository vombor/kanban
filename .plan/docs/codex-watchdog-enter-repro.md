# Codex watchdog Enter: real-TUI reproduction (2026-10-13)

The issue #52 fix in `75181d55` tightened confirmation for an idle, previously hooked session, but did not change
the input protocol. The user reported that Codex still left watchdog wakes in its composer after upgrading to
fork.8. This follow-up was reproduced with the installed **Codex 0.162.1** through a real Kanban sidebar and
the shared headless Chrome, rather than with a standalone PTY or a fake TUI.

## Reproduction

1. Start an isolated Kanban on port 3600, with a temporary Kanban home, HOME, CODEX_HOME and projects root.
   Remove inherited KANBAN_/GIT_ variables; disable context sync and restart wakes; use the default routing kit.
   Copy only the Codex provider configuration into the temporary home, then launch Codex through Kanban's sidebar.
2. Connect to the shared Chrome over CDP and open the throwaway Kanban. Observe its xterm screen and saved summaries.
3. Pause **only this throwaway Codex TUI's native process** briefly, checking its CODEX_HOME matches the temporary
   home first. Queue a real `kanban orchestrator wake`, then resume the TUI after the watchdog's text and CR have
   been buffered. This models a TUI which processes the two writes later than their 200 ms sender-side separation.
4. On fork.8, the text stays in the composer with a blank line appended. There is no prompt hook and no model reply.
   Kanban nevertheless logs `delivered`: a new sidebar starts `running` without a hook, and its repaint counts
   as output evidence. A real browser Enter sends exactly `\r` and submits the existing text; Codex then replies.

The live report's exact scheduling cause remains unknown, but the same externally observed failure is reproduced
deterministically when Codex reads the buffered text and Enter together.

## Why

Codex's `codex-rs/tui/src/bottom_pane/paste_burst.rs` treats rapid unbracketed input as a paste. Its Enter-suppression
window is 120 ms from **when the TUI processes the characters**, not when Kanban writes them. An Enter in that
window inserts a newline. A 200 ms pause at the sender cannot ensure the recipient has consumed the text yet.

Explicit bracketed paste (`ESC[200~` + text + `ESC[201~`) reaches Codex as a paste event, whose
`clear_after_explicit_paste()` clears that suppression window. A following CR is therefore a submission even
when Codex consumes all the bytes together.

Source: <https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/bottom_pane/paste_burst.rs>.

## Fix and verification

- `AgentInputDeliveryProfile.bracketedPaste` in `agent-session-adapters.ts` opts Codex into explicit paste
  boundaries. `deliverTaskInput` still flattens the text and writes Enter separately; other agents keep their
  existing encoding.
- For agents with a prompt-submit hook, output alone does not confirm a fresh session's first submission, even
  when its initial summary says `running`. An already-running session with known hooks retains the existing
  output evidence for input queued during a turn.
- The same real-TUI test with the modified Kanban submits the wake and gets `REPRO_REPLY` without a browser Enter.
- The held-input path also passed: type `USER_DRAFT_SENTINEL`, queue the wake, observe only the user's draft,
  clear it with Ctrl-U, and delay the TUI's input processing. The wake is submitted automatically afterward,
  with the draft excluded from the submitted prompt.
- The same throwaway app verified the card header on a 900 px desktop and a 393 px phone viewport: tokens are
  inside the header, on the task id's line, 10 px from its right edge; time remains in the agent row.

Probe screenshots are local artifacts under OpenCode's data directory (`kanban-input-probe-20261013`). The
throwaway server, its isolated Codex processes, and temporary provider configuration are cleaned up afterward.
