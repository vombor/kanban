This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions. For things like Cline SDK reasoning settings, use the SDK's source of truth whenever possible instead of recreating unions, support checks, or shapes in Kanban.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.

Code quality
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- In `web-ui`, prefer `react-use` hooks (via `@/kanban/utils/react-use`) whenever possible
- Before adding custom utility code, evaluate whether a well-maintained third-party package can reduce complexity and long-term maintenance cost.

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.

Git guardrails
- NEVER commit unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

web-ui Stack
- Kanban web-ui uses Tailwind CSS v4 for styling, Radix UI for accessible headless primitives, and Lucide React for icons.
- Custom UI primitives live in `src/components/ui/` (button, dialog, tooltip, kbd, spinner, cn utility).
- Toast notifications use `sonner`. Import `{ toast }` from `"sonner"` or use `showAppToast` from `@/components/app-toaster`.

Styling mental model
- Use Tailwind utility classes as the primary styling system. Prefer `className` over inline `style={{}}`.
- Prefer Tailwind classes over adding custom CSS in `globals.css` when possible. Conditional Tailwind classes via `cn()` are better than CSS overrides for state-driven styling (e.g. selected/active variants). Reserve `globals.css` for things Tailwind can't express: complex selectors (sibling combinators, attribute selectors), app-level layout glue, or styles that genuinely need to cascade.
- Only use inline `style={{}}` for truly dynamic values (colors from props/variables, computed positions from drag-and-drop, runtime-dependent dimensions).
- The design system tokens are defined in `globals.css` inside `@theme { ... }`. Use Tailwind utilities that reference them: `bg-surface-0`, `text-text-primary`, `border-border`, etc.

Design tokens (defined in globals.css @theme)
- Surface hierarchy: `surface-0` (#1F2428, app bg / columns), `surface-1` (#24292E, navbar / project col / raised), `surface-2` (#2D3339, cards/inputs), `surface-3` (#353C43, hover), `surface-4` (#3E464E, pressed/scrollbars)
- Borders: `border` (#30363D, default), `border-bright` (#444C56, more visible), `border-focus` (#0084FF, focus rings)
- Text: `text-primary` (#E6EDF3), `text-secondary` (#8B949E), `text-tertiary` (#6E7681)
- Accent: `accent` (#0084FF), `accent-hover` (#339DFF)
- Status: `status-blue` (#4C9AFF), `status-green` (#3FB950), `status-orange` (#D29922), `status-red` (#F85149), `status-purple` (#A371F7), `status-gold` (#D4A72C)
- Border radius: `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px)

UI primitives (src/components/ui/)
- `Button` from `@/components/ui/button`: `variant="default"|"primary"|"danger"|"ghost"`, `size="sm"|"md"`, `icon={<LucideIcon />}`, `fill`, children for text content.
- `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter` from `@/components/ui/dialog`: For modals. `DialogHeader` takes a `title` string.
- `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` from `@/components/ui/dialog`: For destructive confirmations.
- `Tooltip` from `@/components/ui/tooltip`: `<Tooltip content="text"><trigger/></Tooltip>`.
- `Spinner` from `@/components/ui/spinner`: `size` (number), `className`.
- `Kbd` from `@/components/ui/kbd`: Keyboard shortcut display.
- `cn` from `@/components/ui/cn`: Utility for conditional className joining.

Icons
- Use `lucide-react` for all icons. Import individual icons: `import { Settings, Plus, Play } from "lucide-react"`.
- Standard icon sizes: 14px for small buttons, 16px for default contexts.
- Pass icons as JSX elements to button `icon` prop: `icon={<Settings size={16} />}`.

Radix UI primitives
- Use Radix directly for headless behavior: `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-collapsible`, `@radix-ui/react-select`.
- Style Radix components with Tailwind classes. Use `data-[state=checked]:` for state-driven styling.

Dark theme
- The app is always in dark theme. Colors are set via CSS custom properties in `globals.css`.
- Surface hierarchy: `bg-surface-0` (app background) -> `bg-surface-1` (raised panels) -> `bg-surface-2` (cards/inputs) -> `bg-surface-3` (hover) -> `bg-surface-4` (pressed).
- Do NOT use Blueprint, Tailwind's light-mode defaults, or any `dark:` prefix. The theme is always dark.

Misc. tribal knowledge
- Kanban's native Cline agent is powered by the installed `@clinebot/core` and `@clinebot/llms` packages plus the local `src/cline-sdk/` boundary layer, so when Cline behavior is unclear, inspect those packages and `src/cline-sdk/` for the real implementation details.
- Kanban is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- If CI hangs on Node 22 after tests seem to finish, suspect a live subprocess or SDK-host startup path before assuming a slow test body. Read `.plan/docs/node22-ci-hanging-tests-investigation.md` before repeating that investigation. `test/runtime/cline-sdk/cline-task-session-service.test.ts` was the big prior culprit because a unit-style suite was still booting the real Cline SDK host.
- When Kanban runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- Moving a card to Done has exactly one implementation: `src/server/task-trash-workflow.ts` (stop task + detail-terminal sessions, start linked backlog tasks, delete the worktree with its patch). The CLI `task done|trash` and the browser call it over tRPC `workspace.trashTask`; the auto-review reconciler calls it in-process. Don't add Done side effects in a caller. The workflow is the only writer of the Done move: the browser shows it optimistically but `useWorkspacePersistence` keeps it out of every save (`holdPendingDoneMove`, see `web-ui/src/state/pending-done-moves.ts`) and flushes pending edits before calling `trashTask`, so no browser save can conflict with the runtime's write. Its `doneGate` dependency is where the `qa` landing step will go.
- Process cleanup lives in `src/server/process-reaper.ts` (match by /proc cwd/exe inside a worktree + the session tree captured before the session stops; SIGTERM → SIGKILL; never PID 0/1/2, kernel threads, the server or its ancestors, zombies, or reused pids). Kernel threads come from PF_KTHREAD, never "child of PID 2": in the pod PID 2 is the Kanban server, so that rule hid every agent PTY. A process's cwd only says which card started it, not who uses it: the Cline hub daemon (`--cline-hub-daemon`) sits in the worktree of the first Cline card and serves all of them, so it, anything with incoming TCP connections from outside the card, accepted connections on a named unix socket, or children in another worktree is only reported as `shared*`, never signalled and `src/server/orphan-process-sweeper.ts` (periodic sweep, `processes.reaper` in config.json). Done, task delete (`workspace.deleteWorktree`) and project removal reap through `prepareTaskProcessReap` in `runtime-server.ts`, always before the worktree is deleted. Process-group or parent-chain kills are not enough: agents start dev servers with nohup/setsid. Only cards that are Done on a readable board are reaped, even with a deleted cwd; missing/unknown/unreadable-board cards are only reported, because a second Kanban home (e.g. a dev instance with another `KANBAN_HOME`) sees the same legacy worktree roots with its own boards. Tests inject a fake process table (`test/utilities/fake-process-table.ts`); never let a test reap anything outside its temp roots.
- Routing (which agent and model a new card gets, whether a card gets QA and from whom, what happens after a FAIL) is a per-project routing kit, never core code: `kits/default.json`/`kits/team.json` plus user kits in `$KANBAN_HOME/kits/`, merged with `workspaces.<id>.kit.overrides` by `src/kits/resolve-kit.ts` and answered by `src/kits/policy.ts`. A workspace without a `kit` entry is on `default` (no routing); nothing is inherited from another workspace. Core code decides on a card's effective agent (`resolveEffectiveAgent()` in `src/core/effective-agent.ts`: session agent > `card.agentId` > selected agent), never on the literal `card.agentId` (a card with no `agentId` runs on the selected agent; misreading that QA'd and landed a whole board on 2026-10-06). The built-in kits are JSON imports bundled into `dist/cli.js`, so editing `kits/*.json` needs a rebuild.
- In Progress ↔ Review moves have one writer: `src/server/session-column-sync.ts` (setting `sessionSync`, default on, read once at startup by `src/config/session-sync-config.ts` for both the server and the browser; the browser's moves in `use-board-interactions.ts` run only when it is off; see `docs/fork/session-sync.md`). It runs on session state changes plus a 10 s sweep, and moves a card only when the summary is newer than the card (`updatedAt` guard). It never moves a Review card that auto-review has armed (`pendingGitAction`) to In Progress: the reconciler's own prompt makes the session run, and the reconciler disarms any armed card that leaves Review, so the card would never reach Done. Code that decides a turn has ended (for example the cline-cli turn detector) must end the turn in the session state machine (`transitionToReview`) and let session sync move the card. Moving only the card leaves a Review card whose summary says "running", and that card gets moved straight back to In Progress (the legacy kit's calibration-card bounce, 10/06).
