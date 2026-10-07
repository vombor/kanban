import { KANBAN_HOME_ENV, KANBAN_WORKTREES_ENV } from "../../src/state/kanban-home";

// Tests point HOME at temp dirs. An inherited KANBAN_HOME would win over HOME and send their
// writes into the developer's real Kanban home, so it is never inherited.
delete process.env[KANBAN_HOME_ENV];
delete process.env[KANBAN_WORKTREES_ENV];
