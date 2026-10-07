import { tmpdir } from "node:os";
import { join } from "node:path";

// Claude/Codex launches pre-trust their workspace by editing the agent's own config file. Point both at
// a directory that never exists, so no test can write to the real ~/.claude.json or ~/.codex/config.toml
// (a missing file is left alone). Tests that exercise the edit pass their own config path.
const missingAgentConfigDir = join(tmpdir(), "kanban-test-agent-config-never-created");
process.env.CLAUDE_CONFIG_DIR = missingAgentConfigDir;
process.env.CODEX_HOME = missingAgentConfigDir;
