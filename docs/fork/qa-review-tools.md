# QA review tools and safety

## Scripted screenshots

`kanban qa shot --base <scratch-app-url> --out <outbox> --scratch <toolchain-copy> --viewports mobile,desktop --script <flow.json>`

A flow is an array of **typed** steps, or an envelope with `steps` and an optional pinned `viewport`:

```json
[
  { "type": "goto", "url": "/" },
  { "type": "fill", "selector": "#title", "value": "QA title" },
  { "type": "click", "selector": "button[type=submit]" },
  { "type": "expectText", "selector": "main", "text": "QA title" },
  { "type": "screenshot", "path": "saved.png" }
]
```

- Arrays and unpinned envelopes run independently at **every** `--viewports` size. Screenshots receive viewport
  suffixes when there are multiple sizes, so desktop never overwrites mobile evidence.
- `{"viewport":"375x667","steps":[...]}` runs only at that explicit size, overriding the CLI viewport list.
- Named sizes: mobile `375x667`, tablet `768x1024`, desktop `1280x720`. Positive `WxH` sizes are also supported.
- Supported types: `goto`, `fill`, `click`, `press`, `select`, `waitFor`, `wait`, `expectText`, `screenshot`.
  Each step requires `type`; unknown fields are rejected. Screenshots use **path**, not `name`.
- `expectText` with `selector` searches only that region; without it, text matching is page-wide. Scope assertions
  to the customer-visible result and verify that edits persist, not merely that unrelated matching text exists.
- All flows/viewports validate **before** browser startup. Invalid input exits 2; browser startup failure exits 3.
  Page/step failures are recorded in the report (exit 0), so inspect `stepFailures`, not only the process exit code.
- `report.txt` includes numeric viewport dimensions; `report.json` records `viewportSize: {width,height}` per run.
  Verify those and the actual PNG dimensions before claiming mobile/desktop evidence. Failed reruns replace stale
  success reports rather than leaving them as apparent new evidence.

Kanban now packages pinned `playwright-core` and `pngjs` modules. `kanban qa tools --json` prints their exact resolved
paths and versions; custom scripts import these explicit paths instead of guessing global/worktree resolution.
`kanban qa tools --verify --json` connects to the shared Chrome sidecar, drives normal fill/click journeys at both
sizes and decodes the actual PNG pixels before reporting readiness. Both native shots and readiness checks create
and close only their own contexts; they never install, download or launch another browser, or use agents' tabs.
`PLAYWRIGHT_CDP_URL` selects the sidecar (default `http://127.0.0.1:9222`); credential-bearing endpoints are refused.
Missing CDP yields a precise environment error, not instructions to repeatedly install Playwright in app copies.

## Scratch setup

The QA gate appends **EXECUTABLE QA SETUP** guidance after the legacy skeleton. Its quoted Bash examples are the
authoritative commands for extraction, diff and npm installation; legacy annotations are not shell arguments.
New copies live under `<qa scratch root>/<workspace>/<QA card>`, with a separate baseline copy. Never delete or
overwrite a copy while tools/servers use it. Do extraction → install → installed generation → verified isolated
database setup → tests/build → browser journeys sequentially, stopping on failure.

Project database setup notes are prose reference material, not something to interpolate into `cd ... && ...`.
Keep ambient credentials private; require a reviewer-specific disposable database and verify the client's actual
database name before schema/seed mutation. If safe setup cannot be proved, retain sanitized evidence and report
STALLED (tooling), not an implementation FAIL or a PASS. A proposed script in chat is not execution proof.

## Explicit starts and continuation

A paused project's explicitly started native QA card is observed as running with its real start time. The pause
still blocks automatic starts, nudges, landing and rework; observation neither launches another turn nor changes
the pause. Existing settled verdict ingestion still applies.

For an explicitly authorized dead Review triage assessment, `kanban task resume <id> --dry-run`, then `resume <id>`
continues the same card, agent/model and evidence-only prompt. A descriptive `BLOCKED:` title on `role: triage` is
not a dev escalation; this continuation does not clear dev pipeline state. BLOCKED dev/QA cards remain refused.

Neither command is approval to reopen a closed benchmark or retry an exhausted/safety-held assessment.

## Escalation acknowledgement and bounded review controls

Only the user and the project's own orchestrator can call these supported server controls, even with isolation off:

```sh
kanban pipeline acknowledge <dev-id> --reason "Reviewer tooling incident; retained evidence" --disposition held
kanban pipeline acknowledge <dev-id> --reason "Wait for independent QA evidence" --disposition deferred --wait-for-task <prerequisite-id> --until <ISO-time>
kanban pipeline acknowledge <dev-id> --disposition clear --reason "Prerequisite repaired"
kanban pipeline conclude-review <dev-id> --qa-task <dead-qa-id> --snapshot <exact-current-sha> --reason "Audited terminal tooling failure; bounded correction exhausted"
kanban pipeline review <dev-id> --snapshot <exact-current-sha> --evidence-only --reason "Exactly one independently authorized reassessment"
```

Add `--workspace <id>` when outside the project directory. Acknowledgements leave the escalation, hold and verdicts
unchanged. They suppress identical escalation wakes while the recorded card/prerequisite evidence remains unchanged,
and expiry or a material snapshot/verdict/column/edit change re-enables notices. ATTENTION lists acknowledged holds
separately, not as untriaged human decisions. Done/deleted cards are never reopened or reawakened by these controls.

Concluding a dead/superseded native review records **operator-audited STALLED**, with null scores and the audit reason,
never a fabricated reviewer verdict or developer FAIL. Its queued replacement is superseded and the implementation
gets an explicit manual disposition that blocks automatic recovery, replacement, landing, rework and fallback.
Existing ingested verdicts are immutable. Partial outbox evidence is also retained before automatic restart retirement
when it is available; missing temporary files are not represented as recovered artifacts.

An explicitly authorized evidence-only reassessment is one new isolated reviewer of the exact unchanged snapshot,
using the project's current QA route. It can run while automation stays paused, and is still subject to capacity,
quota and cloud-slot limits. It neither clears the escalation nor reopens/changes a closed runoff. Findings are kept
separately in `manualQaVerdicts` and an `evidence-<qa id>` artifact directory, not added to benchmark scores or normal
PASS/rework decisions. A failed, missing, dead or errored reviewer yields STALLED without extra nudges/replacements.
The target must remain on the live board (not Done), have a recorded exact snapshot, and not be running. This is a
tool to enact a separately authorized review, not standing permission to retry exhausted experiments.
