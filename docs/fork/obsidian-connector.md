# Optional app-level Obsidian connector

**Global Settings → Knowledge → Obsidian REST API** configures one optional system-level connection. There is no
required external knowledge service and the default is disabled/unconfigured.

Fields:

- Enable/disable the connector.
- REST API base endpoint reachable **from the Kanban server**, without embedded credentials, query or fragment.
  Localhost inside a container addresses that container/pod, not the host. Use the deployment's reachable address.
- Masked API key. Leaving it empty keeps the saved key; entering a new key rotates it. Disable first to remove it.
- Optional PEM CA certificate for the plugin's HTTPS server. TLS verification is never globally disabled.

HTTP is supported for trusted private deployments, with a warning that it sends the key without encryption. HTTPS
with the plugin's CA is preferred. No endpoint or port is baked into installation configuration.

**Test connection** authenticates the current draft and reads only status/OpenAPI metadata. It does not save the
draft, read a vault note, execute an Obsidian command, install a plugin or build a vector index. It reports native
graph metadata, search and document-map capabilities and indexing activity when the server advertises it. HTTP 200
with `authenticated: false` is a failed authentication test. Quiet indexing is not proof of a complete graph.

The verified Local REST API 5.4.0 exposes links/backlinks/unresolved links in its note JSON, plus tags/frontmatter
and native search. Kanban detects advertised schemas rather than assuming a generic `/graph` route exists.

The popup's main **Save** button saves connector edits along with the other Global Settings; there is no separate
connector save button. Cancel/close discards the unsaved key draft, and Test connection never persists it. If a save
fails the popup stays open, successful changes are retained, and the remaining draft can be corrected/retried.

Connector settings and key persist in `<home>/secrets/obsidian-connector.json` (0600), using the canonical
Kanban home and durable writes. It is included when the home/secrets are backed up or migrated. Only the user can
read/edit/test this configuration via strict caller checks, including with project isolation off. Saved keys are
not returned to the browser, agent APIs, terminal environment or prompts. Concurrent stale saves are refused.
Like the GitHub App credential file, this private server-owned file is not a protection against arbitrary code
running as the same Unix user. Never commit or export it as knowledge.

## Current implementation boundary

This first slice configures and verifies the connector. It does **not yet** expose graph traversal to agents, apply
project-folder/Shared mappings, import/export notes or enable broad MCP access. Those are dependency-ordered tasks
in `docs/specs/cost-aware-multi-agent-coordination.cards.json`.

The planned retrieval boundary will distinguish:

- Kanban-owned, immutable execution plans/contracts with task-pinned revisions.
- A project's private Obsidian collection.
- User-designated, read-only Shared collections available to explicitly opted-in projects.

Relationship traversal must scope every node/edge/search result; links never grant access to another project's
private notes. Publishing global/shared knowledge remains user-controlled. No credential is handed to agents.
