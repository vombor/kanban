# Supervision: maintainer versus project runtime

Maintainer automation belongs outside the shipped package. Its source, build, tests and operator instructions
now live in [`tools/maintainer`](../../tools/maintainer/README.md). Existing installations keep their private,
immutable host artifacts, configuration, schedule and receipts; moving source does not reset an admitted job.

End-user objective supervision belongs in Kanban's runtime and existing project-scoped pipeline/watchdog owners,
not in an external Desktop OpenCode conversation or a new all-project LLM super orchestrator. The implementation
plan is `.plan/docs/maintainer-runtime-supervision-split.md`; do not treat that plan as shipped capability.
