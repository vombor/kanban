import { KANBAN_HOME_ENV, KANBAN_WORKTREES_ENV, LEGACY_KIT_ENV_NAMES } from "../../src/state/kanban-home";

// Tests point HOME at temp dirs. An inherited KANBAN_HOME would win over HOME and send their
// writes into the developer's real Kanban home, so it is never inherited. The same goes for the
// legacy kit's KANBAN_KIT_HOME / KIT_CONFIG (doctor and import-kit read the legacy kit's files).
delete process.env[KANBAN_HOME_ENV];
delete process.env[KANBAN_WORKTREES_ENV];
for (const name of LEGACY_KIT_ENV_NAMES) {
	delete process.env[name];
}
