# The team workflow, and why

The team workflow runs a project on a Kanban board as if the cards were a small dev team. Juniors write code, a
reviewer from another vendor checks every change before it lands, failed work goes back to the same card and model,
crashed agents get nudged, and a person is pulled in only for real decisions. It started as the legacy dev-team kit
(`/root/.kanban`: services, scripts and a `kit` CLI next to Kanban) and is now part of this fork. Most rules below came
out of running the `foo` (Pawsome) board on 2026-10-04…07. Each rule says why, so it can be changed knowingly. The
incident behind a rule is indexed in [HISTORY.md](HISTORY.md) by the commit that introduced it.

Operations are in [RUNBOOK.md](RUNBOOK.md), settings in [CONFIG.md](CONFIG.md), routing kits in [KITS.md](KITS.md).
The design is `docs/fork/kit-merge-plan.md`.

## 1. Core and routing kits

The workflow has two halves:

- The **core** is the mechanics, built into Kanban, the same for every project and agent-agnostic: landing modes,
  landing, snapshots, scripted checks, the QA gate, the rework loop and its limits, holds, escalation, session sync,
  recovery, the watchdog and input delivery.
- A **routing kit** is policy, one per project: which agent and model a new dev card gets, whether a card gets QA and
  from whom, what happens after a FAIL, and which team features run ([KITS.md](KITS.md)).

The core resolves facts, and the kit decides routing. The core never compares an agent id to a constant and never
makes a routing decision itself.

**Every project is on the `default` kit with landing `off` until someone opts it in.** Its cards run on the agent
selected in Kanban settings, nothing is QA'd or reworked, and the orchestrator or the user lands. Nothing is
inherited from another project. Why: on 2026-10-06 a new board (`kanban-2uge`) inherited foo's top-level routing
from the legacy kit's config. The legacy kit also skipped only cards whose **literal** `agentId` was `"claude"`, so
cards with no `agentId`, which run on the default agent (Claude), counted as Cline dev cards. It QA'd and landed
cards that were meant to be landed by hand. Hence two rules:

- A project without a kit entry gets `default`.
- Every decision uses the card's **effective agent** (`resolveEffectiveAgent()`): the agent its session ran on, else
  `card.agentId`, else the selected agent.

`test/runtime/pipeline/effective-agent-incident.test.ts` keeps both.

**One owner per responsibility.** Every runtime feature ships off, in shadow, or report-only, and is switched on per
workspace when its legacy kit service is switched off. `kanban doctor` fails when both would own the same thing (its
one-owner check). As of 2026-10-07 the legacy kit's `column-sync` and `model-lists` services are retired: session
sync and the model-lists route own those jobs. Its `autoland` and `review-watch` still run, so the pipeline's
recovery stays `report`, the watchdog stays `off`, and foo is not on landing `qa` yet.

## 2. Who does what

| Role | Who | Why |
|---|---|---|
| Dev cards | whatever the project's kit assigns at creation (`team`: Cline on the tier-3 model), else the selected agent | cheap, and comparable across models when every round is scored |
| QA cards | the kit's `qaPolicy`: `team` picks by the dev card's model vendor (OpenAI-built cards → Cline on Haiku 4.5 plus a "drive the changed path" step, everything else → Codex). The QA vendor must differ from the dev vendor (user rule 2026-10-06) | an independent reviewer from another vendor. Haiku won calibration for OpenAI-built cards but once missed a defect on a path it never exercised, hence the drive step |
| Plan cards | the kit's `plan` section (`team`: Claude on its CLI's default model, starting in plan mode; `default`: none) | the architect: turns a requirement into a reviewed spec and a card breakdown (§13). Separate from the orchestrator (user 2026-10-07), so planners can be benchmarked later |
| Orchestrator | the agent selected in Kanban settings, in the sidebar (`__home_agent__:<ws>:<agent>`), never a hard-coded id | the scrum master: escalations, starting cards, expanding approved plans, tooling |
| Moving cards, landing, rework, nudges | the server and the pipeline worker, no LLM | deterministic, free and always on |

- No agent polls the board. Agents start only when there is work: a QA card per submitted snapshot, and an
  orchestrator wake per ATTENTION item. Tokens don't go on status checks.
- The orchestrator works on the project and every worktree, so card guardrails don't apply to it (§9).

## 3. Landing modes

`workspaces.<id>.landing.mode` is a core setting, separate from the kit.

| Mode | What happens to a finished card |
|---|---|
| `off` (default) | nothing: the orchestrator or the user reviews, lands and moves it to Done |
| `commit` / `pr` | upstream auto-review: the agent is prompted to commit (or open a PR), and the card goes to Done once HEAD moves |
| `qa` | the pipeline: snapshot, checks, the kit's QA, then **Kanban** squash-lands the work onto the base before Done |

In `qa` mode the agent never commits or lands. The Commit / Open PR buttons on such a card become **Approve & land**
(the same land, without QA, recorded as `HUMAN_APPROVED`). A manual Done on a card with unlanded work asks "land or
discard?". A Done with no answer is refused, so nothing lands silently and nothing is lost silently.

## 4. QA gates landing (landing `qa`)

```
dev card stops ─▶ Review (settled) ─▶ snapshot refs/kanban/snapshots/<id> ─▶ checks ─▶ kit qaPolicy
                                                          QA card waits for the checks (or checksWaitMin) ┘
                                                                                    │ qa
                                                    QA card (role qa, reviewsTaskId) ─▶ verdict.json
                     ┌───────────────────────── PASS ──────────────────────────────┤
                     ▼                                                             │ FAIL / STALLED
     onPass: land ─▶ merge-tree ─clean─▶ squash-land ─▶ Done ─▶ dependents start   ▼
                     │ conflict                                        kit onFail: rework (same card, same model)
                     └──────────────▶ counts as a FAIL round ──▶        │ cap / STALLED / unchanged
                                                                       ▼
                                                     escalate (BLOCKED: in Backlog, ATTENTION.md, wake) or stop
```

- **Review means "submitted"**, but only once it has settled. Kanban moves a card to Review whenever its agent stops.
  The pipeline acts on a Review only after `sessionSync.reviewSettleSec` (12 s) with no new state change or hook
  activity. Why: Copilot's autopilot flips a card to Review for ~100 ms on every continuation, and a background shell
  can start a new turn ~6 s after the final stop. QA then snapshotted half-done work.
- **Snapshots** are commits under `refs/kanban/snapshots/<id>` with a fixed `kanban@localhost` identity, because a
  dangling `~/.gitconfig` broke every legacy snapshot once. A snapshot equal to its base is not submitted: the agent
  likely never ran.
- **Scripted checks** (`typecheck`, `lint`, `test`, `build` when the project has them) run on a clean export of the
  snapshot: one run at a time machine-wide, niced, test runners capped, no `KANBAN_*` variables. They are input for
  QA, not a gate, because the base itself may be red.
- **QA waits for the checks.** The QA card is created only once the checks of the card's current snapshot have
  finished (PASS, FAIL or ERROR), and its prompt ends with their report: per step the result, the command, the
  duration and the last 60 lines of a failed step's output. An ERROR (the checker itself failed) says the checks did
  not run, so QA runs the scripts itself. No QA slot is used while the checks run. After `pipeline.qa.checksWaitMin`
  (20 min) QA starts anyway, with "checks timed out" in the report. A new snapshot while the checks run starts a new
  wait and stops the old run, so the stale snapshot never gets QA. A project without checks, or a snapshot whose
  package.json has none of the check scripts, gets its QA card right away. Why: QA used to start at the same moment
  the checks were queued, never saw them, and foo 27549 landed with only a checks ERROR.
- **QA only records.** A QA card reviews the snapshot (diffed against its merge-base, so work landed on the base since
  doesn't read as a revert), tests it in a scratch copy with the project's own tooling, and writes
  `<outbox>/<qa id>/verdict.json` plus artifacts. It never runs `kanban`, never moves cards and never writes the Kanban
  home. When it stops, the QA gate ingests the outbox: QA log, artifacts, the dev card's pipeline state, the
  `verdictRecorded` event (the team scoreboard), and the QA card to Done (never landed). One actor moves cards, so QA
  can't race the lead.
- **Missing or bad verdicts** get `pipeline.qa.maxNudges` nudges that quote what is wrong, after a 20 s grace. Then
  the round is STALLED. A UI card can't PASS with its visual check blocked: that counts as STALLED too.
- **PASS** → the kit's `onPass` (a runoff may hold it) → the Done workflow's landing step: a `git merge-tree`
  pre-check, then commit-tree + update-ref when the base isn't checked out, or `merge --squash` in the checked-out
  base with the user's edits stashed and restored. Then the kit's `postLand` commands run. The card goes to Done only
  after the base has the work, and only then do linked Backlog cards start.
- **FAIL → rework on the same card with the same model**, like reopening a ticket. A `REWORK round N` section goes
  into the card prompt before its FINAL STEP, the QA write-up and artifacts go into `.qa/r<N>/` in the worktree
  (git-ignored), and the section is typed into the card's own session. If the session is big (past
  `clearAfterTurns` turns or `clearAfterTokens` of last input), it is cleared first and the whole prompt is resent:
  like a person coming back to a ticket who remembers the gist, not every keystroke. A rework that doesn't show up as
  started within 2 minutes is restarted once, then escalated.
- **A merge conflict at land is a FAIL round**, with rebase notes, because QA passed the work itself.
- **The cap is the core's.** At `pipeline.rework.maxFailRounds` FAIL rounds (plus a handback's extra rounds), or on
  STALLED or a rework that came back unchanged, the kit's `onFail.then` runs: `escalate` or `stop`. A rework that
  would switch model is refused and escalated.
- **Escalation to the orchestrator:** `qaflow.escalated`, `## ESCALATE` in the QA log, and the card to Backlog as
  `BLOCKED: …`. The watchdog writes ATTENTION.md and wakes the orchestrator. **Escalation to a model** (team's
  `{ tier }` opt-in): the work is tagged `preserve/<id>-<model>`, and a sibling card takes the task over on that model
  (left in Backlog when approval is required).
- **Siblings are never linked on the board.** A board link starts a Backlog card when the other one goes Done. Once,
  a linked sibling that a human started and landed restarted its BLOCKED original, and both landed. The relation
  lives in pipeline state instead, and the engine and the QA gate never QA or land an escalated card. Only
  `kanban task handback` clears an escalation.
- **Handback** is append-only: the escalation moves into `handbacks[]`, `## HANDBACK` goes in the QA log, and the
  `BLOCKED: ` prefix is dropped. Extra rounds (`--extra-rounds N`) rework the escalating FAIL once. Nudge and retry
  budgets restart. More rounds than the cap is a budget call: only on the user's say-so.
- **Runoffs** (team kit): several cards race the same task. Each one's PASS is held, and once every card has passed
  or escalated, the best mean QA score wins (then fewer FAIL rounds, then lower cost). The winner lands, and losers
  are tagged and discarded. The group is recorded before any card is created, so no card can land outside it. No
  hold is a dead end: `kanban task release-hold --land|--discard` is the human way out. A winner whose land
  conflicts goes back for a rebase rework, then QA, then lands. If that rework is escalated, the winner can be handed
  back like any card. A loser of a decided runoff (any card of a `benchOnly` one) never lands: handback,
  `task done --land`, `approve` and `release-hold --land` refuse it, and a PASS it still gets is held, never landed.
  The decision is final, even if the winner is discarded later: nothing lands the runner-up. To use a loser's work,
  start a new card from its `preserve/<id>-<model>` tag.

## 5. "Review" means the agent stopped, not that the work is done

Recovery (`src/pipeline/recovery*.ts`) sorts every stop before anything treats it as finished work:

- **Crashes** (an error stop, Cline's session file `failed`, a Kanban `exit` with a warning) get a nudge instead of a
  QA round: "continue", or `/clear` plus the whole card prompt for a poisoned history (context overflow, a model that
  rejects images, an empty reply Bedrock refuses to replay). After `maxNudges` nudges it escalates.
- **Premature stops** (a turn that ends on an announcement, or an empty reply, without a tool call) get "continue",
  up to `maxContinues`, with no QA. An empty reply at the output cap is a cut-off tool call ("split writes").
- **Provider errors** (5xx, 429, "temporarily unavailable", stream timeouts) get backoff retries (1, 2, 4, 8 min)
  outside the nudge budget. When the retries are used up, the card is held in Review (no QA, no nudge, no stall
  wake), its model is probed every 5 min, and it resumes after 2 good probes in a row or escalates after 6 h.
- **Hung requests** (running, reply owed, no writes for 15 min, or 30 on Lemonade's first call) are cancelled with Esc,
  then retried or held.
- **Why a Cline card stopped** comes from Cline's own session files and runtime events first, Kanban's summary
  second. The Cline rule `status-line.md` makes every model end a finished turn with `STATUS: DONE`,
  `STATUS: BLOCKED: …` or `STATUS: NEEDS_INPUT: …`.
- A delivery is confirmed only by a state change or a hook. Output doesn't count, because an idle TUI repaints.

Recovery doesn't move cards after a nudge: session sync follows the session. `pipeline.recovery.mode` is `report`
until the legacy autoland is retired, because both would nudge every card twice.

## 6. Board moves have one writer each

- **In Progress ↔ Review**: session sync (`src/server/session-column-sync.ts`), on every session state change plus a
  10 s sweep, with or without a browser open. Only a session summary newer than the card moves it (the `updatedAt`
  guard), so a stale summary can't undo a rework that was just sent. Code that decides a turn has ended ends it in the
  session state machine and lets session sync move the card. An idle Cline TUI that still reports "running" doesn't
  bounce its card out of Review (the turn-end check, `agents.cline.turnDetector.mode`).
- **Interrupted cards are never moved to Done** (upstream's browser rule trashed card 62a99).
- **To Done**: only the Done workflow (`src/server/task-trash-workflow.ts`). It stops the sessions, lands (landing
  `qa`), saves the patch, reaps the card's processes, deletes the worktree and starts linked cards. The CLI, the
  browser, auto-review and the pipeline all call it. The browser shows a Done move optimistically but never saves it
  itself.
- **Headless browsers never drive the Kanban UI.** A hidden or throttled viewer pauses the terminal flow control and
  freezes agent sessions (the sidebar freeze of 10/05). Visual QA uses a headless browser only against the app under
  test.

## 7. Talking to running cards

- Input goes through one function, `deliverTaskInput()`: PTY typing with newlines flattened, a separate Enter, the
  Copilot focus-in escape, an activity check and a second Enter. Rework, nudges, `kanban task send` and sidebar wakes
  all use it.
- **Never stop a session to switch models.** It ends as "interrupted" and the card moves. Use `kanban task
  restart-fresh <id> --model … --label …` (it tags the work, resets the card's pipeline history, and starts it on the
  new model).
- A dead card is resumed with `kanban task resume <id>` (WIP tag, same model), not `kanban task start`. Start refuses
  Review cards, and `startTaskSession` hands a live session back unchanged.
- Don't edit `pipeline-state.json` by hand. `kanban task handback` and `release-hold` write it under its lock and
  record what they did.

## 8. The watchdog wakes the orchestrator; nothing polls

The watchdog (`src/pipeline/watchdog/`, in the pipeline worker) is LLM-free and ticks every 60 s:

- **After a restart:** the QA gate replaces a dead QA card on its own. The watchdog reports a Review card only when
  that didn't happen within `stall.restartGraceMin` (1 min): its dead QA card not superseded, or superseded with no
  new one. A replacement waiting for a QA slot or PID pressure is only logged. A card still held for the restart (an
  orphan mark nobody resumed) is reported after the same grace plus its place in the resume queue.
- **Stalls:** Review with no QA (10 min), a QA card stuck (45 min, not calibration cards), In Progress with a dead
  session. That one gets a single LLM-free continue after 5 min before anyone is woken.
- **Prompts:** a Claude Code or Codex card stuck on a trust, startup or permission dialog (3 min), on every
  workspace. It is flagged, never answered: the trust dialog defaults to "No, exit". Every workspace's main repo
  root is pre-trusted to prevent it.
- **Escalations and stops**, an idle pipeline (a new Backlog card gets 10 min of grace), and open orchestrator-plan
  steps.
- **PID pressure:** at 75% of `pids.max` it raises a flag that holds new QA cards, restart resumes and calibration
  waves, and runs the orphan process sweep. At 90% (brownout), running agents get one Esc.
- **Housekeeping:** hourly prune of Done cards older than 3 days (after a backup; undecided runoffs and running
  calibrations are kept), and the team features' daily jobs (the price check).

It writes `data/<ws>/ATTENTION.md` (keeping the orchestrator's own "needs the user" section) and wakes the
orchestrator once per item per 30 min. It types into a live sidebar session, queues behind a running headless run,
or else starts a headless run (`claude -p` / `codex exec`, with a lock and a timeout) or the sidebar session
server-side. It never leaves zero orchestrators and never starts two. A workspace's items only ever wake that
workspace's own orchestrator; with its wakes off (`workspaces.<id>.orchestrator.wake.enabled: false`) they are only
listed in its ATTENTION.md. Items that are open "needs the user" entries don't re-wake.

## 9. Guardrails for task cards

Task-card agents get hard limits ([CONFIG.md](CONFIG.md) `guardrails`), each enforced by the agent CLI's own
mechanism: no `git push`, no history rewrites or ref moves on shared branches, no container or service restarts, no
`kanban home migrate`, and writes kept inside the card's worktree. Card-local rebases and resets stay allowed. Why:
cards run with their CLI's approvals bypassed (autonomous mode), so one wrong command could push, rewrite a shared
branch or restart the pod. The orchestrator is exempt: it lands work and maintains tooling.

## 10. Restarts

A Kanban or container restart kills every running card, because the PTYs are children of the server. Kanban knows
its own start time (`<home>/run/server-start.json`). After a restart, a card whose session started before this
server and has no process is an **orphan**, unless its turn had already ended (finished work waits for QA as usual).
Nothing nudges, QA's, snapshots or escalates an orphan. Dev orphans are resumed one at a time, 20 s apart, on the
same model, after a WIP tag `preserve/<id>-wip-<stamp>-restart`. Mid-run QA cards are recreated for the same
snapshot, and calibration cards are left to their runner. `kanban restart prepare` tags the WIP and writes `restart-manifest.json` (the image entrypoint runs it on every
container stop, after the legacy `kit prepare-restart`). The server also writes the manifest itself, without WIP
tags, every 5 minutes, 15 s after an In Progress/Review change and at a clean shutdown, so a crash, OOM kill or power
loss still leaves one a few minutes old. It never carries a tag over, and recovery always tags its cards fresh at
resume. Its cards also get the "turn had ended" check, and one more than a day old is ignored. A listed card whose
session ended its turn after any manifest was written, prepare's included, is finished work, not an orphan. A manifest is used only by the start right after the server that wrote it, and is never replayed. Until the cutover, the legacy autoland does this (since kit `a2b4695`
it also resumes Claude cards with `claude --continue` and a short resume note), and the runtime only reports it.

## 11. Models

- **US inference profiles only** (`us.*`). Use the in-region id only when no `us.*` profile exists. Never `global.*`.
- **Never xAI** (Grok, `xai.*`), for anything, benchmarks included. The probes skip them.
- **Tiers** (team kit `tiers`): tier 3 is the cheap tier (under about $20 per typical run) and is what new cards
  get. Tier 2 costs more and needs the user's go-ahead. Dropped models are never picked again.
- **Costs are list prices** (`data/prices/prices.json`, per 1M tokens, cache reads and writes priced separately). Card
  metrics de-duplicate a resumed Cline session's copied messages and skip its cumulative last message, or turns and
  cost count twice. Models come from the session files, not the board, because board settings get edited after the
  work is done.
- Lemonade loads one model at a time (`models.providerCapacity.lemonade.maxLoadedModels: 1`): a rework or start on
  another Lemonade model waits.

## 12. Where it runs

| Part | Process | Why |
|---|---|---|
| Session sync, the Done workflow, landing, delivery, trust, guardrails, the home resolver, dev assignment at creation | the Kanban server | Kanban semantics; they change rarely |
| Pipeline (snapshot, checks, QA gate, rework, recovery), the watchdog, the kit resolver, the team features | `kanban pipeline worker`, a supervised child of the server, started only when needed | a pipeline fix is a worker restart, not a container restart (which kills every card); `pipeline.workerEntry` can point it at a newer build |
| Calibration runs | a detached `kanban bench calibrate` process | a run lasts hours and must survive a worker reload |

The worker never writes the board and never touches a PTY. It asks the server through a request channel (create,
start, resume, update or block a card, deliver input, finish a card through the Done workflow). The server refuses
card actions for a workspace that isn't on landing `qa`, except `resumeTask`, which restart recovery also uses on
landing-`off` boards.

## 13. Plans: requirement → plan card → approval → dev cards

A big requirement is planned before it is built, by a **plan card** (`role: "plan"`), not by the orchestrator.
Planning is the architect's job and orchestration the scrum master's (user decision 2026-10-07): the planner reads
the code and writes the plan, and the orchestrator turns the approved plan into cards and runs them.

1. **Requirement → plan card.** `kanban task create --role plan --title "Coupons" --prompt "<the requirement>"`.
   The kit's `plan` section picks the planner's agent, model and plan mode (`team`: Claude, no model pin, plan
   mode on). The card's prompt is the plan template (`src/kits/plan-prompt.ts`) around the requirement. The plan is
   recorded in `data/<ws>/plans.json` with its slug. On a kit with `plan.enabled` off (`default`) this is
   refused: the one agent plans its own work, as before.
2. **The planner** reads the codebase, then writes `docs/specs/<slug>.md` (problem, goals, non-goals,
   user-visible behaviour, design citing the real files, risks, test plan, rollout/flags, open questions) and
   `docs/specs/<slug>.cards.json` (cards with title, prompt, `dependsOn` by local id, `parallelGroup` and
   acceptance criteria, each sized for one agent session). It checks the file with `kanban plan check`, creates no
   card, and ends with a STATUS line. Schema: `src/plans/plan-breakdown.ts`.
3. **Review and approval.** `kanban plan show <id>` prints the spec and the breakdown. Only the **user** approves
   (user decision 2026-10-07), in every isolation mode, `off` included: **Approve plan** on the plan card in Review
   (a dialog with the spec's title and the card count), `kanban plan approve <id>`, or `kanban plan expand <id>
   --approved-by-user`. All three ask the running server (`plans.approve`, `src/trpc/plans-api.ts`), never write
   in-process. It refuses every agent session (orchestrator or card, any project; by credential or traced to its
   process tree) with "Plan approval is the user's; ask them to run kanban plan approve <id> or use the board", and
   the CLI refuses `plan approve` and `plan expand --approved-by-user` inside a session. "No credential and no session
   above it" is not proof of the user (a reparented process looks the same), so the approval then waits for the
   one-time code the server prints on its console (the terminal that started Kanban, or `podman logs`): the CLI asks
   for it on the terminal (or waits for `kanban isolation approve <approval id> <code>`), the board's dialog has a
   code field. A browser signed in with the passcode (remote mode) needs no code. The approval is pinned to the
   breakdown's sha256: the one the user was shown (a breakdown changed while the code waited is refused), and an
   edited breakdown needs a new approval. The orchestrator then runs `kanban plan expand <id>` without the flag.
4. **Expand.** `kanban plan expand <id> [--dry-run]` validates the breakdown, creates the cards in Backlog through
   the normal create path (so the kit's `devAssignment` picks their agent and model), appends each card's acceptance
   criteria to its prompt (before a FINAL STEP, so the QA prompt's requirements include them), links them by
   `dependsOn`, and records plan → cards in `plans.json`. The task ids are written before the first card, so an
   expand that stopped half way resumes with the same ids. It **never starts** a card and never links one to the
   plan card (a link would start the first wave when the plan card goes Done). The orchestrator starts them.
5. **The spec lands like docs.** The plan card's spec files land the project's normal way: on landing `qa` a
   human's Approve & land or Done with "land" (no QA: the pipeline never QAs a plan card, so no PASS lands one), on
   other modes Commit / Open PR or by hand. The spec then sits in the repo next to the code it describes.

**Threshold.** A one-card, non-cross-cutting request (one module, one session) skips the planner: the orchestrator
creates the dev card directly. Plan when a request needs several cards, touches several modules or teams, or needs a
design decision the user should see first.

The pipeline leaves plan cards alone, as calibration cards: no snapshot, checks, QA, rework, recovery nudge,
auto-review, restart resume (resume one by hand with `kanban task resume`) or watchdog stall. `kanban plan metrics`
lists per plan the planner's agent and model, duration and cost (card metrics, at expand), the number of cards, the
approval and the reworks of its cards, for a later benchmark of planners (Claude, Codex, Copilot: `plan.candidates`
in the kit). No runoff or calibration of planners exists yet.

## 14. Issues → cards

A project can pull issues from **its own** remote repository into its board (`workspaces.<id>.issues`,
[CONFIG.md](CONFIG.md); GitHub today, behind an `IssueProvider` interface for GitLab or Gitea later). The repository
is derived from the project's `origin` remote and pinned on the first sync, and a configured `issues.repo` must be
one of its own remotes: project isolation means a project only ever reaches its own repository (a card that changes
`origin` gets the import refused, not redirected).

1. **Sync.** Every `issues.pollMin` the pipeline worker's sync job (`src/issues/issue-job.ts`, in the watchdog's job
   runner, so `watchdog.mode: on`) lists the issues updated since the last sync with conditional requests (ETag), and
   backs off when GitHub rate-limits. `kanban issues sync [--dry-run]` runs one sync by hand; `kanban issues list`
   shows what is imported, what was skipped and why, and the last sync. Card sessions can't run `issues sync`
   (it uses the user's token); the user and the orchestrator can. Every decision goes to the decision log
   (stage `issues`); `kanban doctor` has a row per project.
2. **Trust filter.** An open issue (never a pull request) is imported only if its author is OWNER, MEMBER or
   COLLABORATOR, or it carries the `kanban` label, which needs triage rights to apply. Labels to include or exclude
   and the trusted associations are configurable. Comments are filtered the same way: an untrusted user's comment
   is left out, with a line saying how many were.
3. **Import.** Each matching issue becomes one **Backlog** card titled `Issue #N: <short title>` (just `Issue #N`
   when its author isn't trusted), created through the normal
   create path (the kit's devAssignment picks agent and model; with the `needs-plan` label and a kit with the plan
   role, a plan card instead). The card carries `issue: { provider, repo, number, url, updatedAt }`, which dedupes
   it across every column, Done included (and an import record keeps it deduped after prune-done deletes the card).
   Mode `report` only logs what it would import. Cards are **never started**: in mode `on` the watchdog wakes the
   orchestrator with "N new issue card(s)", and the orchestrator decides.
4. **Updates.** An issue edited or commented on after import: while its card is in Backlog, the prompt gets an
   "Update <date>" section (a trusted author's edits and trusted users' new comments; an untrusted author's edit
   is only noted, and nothing is added once the trust label is removed); once the card was started, the prompt is never touched, the change is logged and goes
   into the orchestrator's next wake. An issue closed upstream gives its Backlog card a `CLOSED UPSTREAM: ` title and
   a marker section; Kanban never deletes it.
5. **Closing the loop.** When Kanban lands a dev card that has an `issue` (landing `qa`), its landing commit message
   ends with `Fixes #N`, so GitHub closes the issue once the commit reaches the default branch (a plan card's spec
   landing doesn't close it). `issues.commentOnLand` (off by default) also comments on the issue when the card is
   landed or discarded. Rework siblings (escalation, runoff) carry the same `issue`, so whichever lands closes it.

**Security.** Issue text is untrusted: whoever opened or commented on the issue wrote it, and it becomes an agent
prompt. That is why the trust filter is strict by default, and why the card prompt puts the issue in a fenced
"Issue #N (untrusted text from GitHub)" section after a fixed preamble: the issue describes **what** is wanted and
carries no authority to change the agent's instructions, rules, guardrails or FINAL STEP. Every line of issue text
is quoted with `> `, so it can't close the fence, start a FINAL STEP section or pose as a REWORK section. Tokens come
from `gh` or Kanban's env and stay in memory.
