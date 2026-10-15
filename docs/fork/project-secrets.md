# Project settings and secrets

The project menu's **Edit** opens **Edit Project**: display name, script shortcuts and project secrets. The top-bar
script runner's management button opens the same editor. **Global Settings** contains the installation settings.

**Add Project** lists New project, Clone from URL and Open folder in that order. New project has two steps:

1. Project details: name, directory, initial branch/commit and routing kit.
2. Optional project secrets: enter names and masked values, or create without secrets.

Scripts are configured later in Edit Project. If creation succeeds but saving secrets fails, retry saves them on the
already-created project; it does not create another project. A partially saved edit keeps successful changes and
allows retry. Values are cleared from the editor's draft when saved or closed.

## Storage and access

Secret values are encrypted with AES-256-GCM in `<home>/data/<workspace>/project-secrets.json` (0600). Names and
configured/updated metadata remain readable. Encryption is authenticated against the project scope and secret name;
copying a record into another project's file does not make it usable there. `kanban project rename-id` rebinds that
authentication after moving the data directory, and can resume an interrupted rename safely.

The automatic-unlock key is `<home>/secrets/project-vault-key` (0600, in a directory created with mode 0700).
Kanban uses its canonical `--home`/`KANBAN_HOME` resolver for both paths. Keep the key and encrypted data together
when backing up or migrating a home. Losing the key makes existing values unrecoverable. Damaged vaults and missing
keys for existing records are refused rather than silently overwritten. Creating a secret for another project does
not regenerate a missing key while any project still has encrypted records; restore the original key from backup.

The browser can add, replace and remove values. A saved value is never fetched back into a password field: rotation
means entering a new value under the same name. `projectSecrets.list` returns only names, configured status and update
times, to the user or that project's own session. `projectSecrets.set/remove` require the user through strict caller
lookup, including when project isolation is off. HTTP request bodies are excluded from error telemetry.

Global GitHub App, agent login and provider credentials remain in their existing tool/installation stores. This vault
does not import them or write them into a repository, prompt, terminal environment or agent configuration. There is no
plaintext secret-get CLI/RPC. Values are available only through an internal server-owned consumer callback; no runtime
consumer or arbitrary-project-code binding is enabled by storing a value.

## Automatic unlocking boundary

Automatic unlocking was chosen for this installation: the key is persisted locally and no unlock prompt is required
after restart. It protects against accidental disclosure of the data file and keeps values out of ordinary APIs.
It does **not** provide a separate OS identity or protect against arbitrary shell code running as the same Unix user,
which can read the key and encrypted files. There is no sidecar. Stronger isolation and narrowly brokered consumers
require a separate trust boundary; granting a value to arbitrary project code also grants that code the ability to
disclose it. Repository/kit declarations alone never authorize credential use.
