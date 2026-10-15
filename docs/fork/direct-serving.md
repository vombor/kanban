# Direct serving and installation ports

One Kanban instance can serve localhost and its public DNS name simultaneously. HTTP requests, the runtime state
WebSocket and terminal WebSockets have no Origin or Host allow-list. No `allowedOrigins`, public-origin setting or
Caddy header rewrite is required. The browser uses page-relative `/api/trpc` requests and the current page's host
and protocol for state/terminal sockets, so each open tab keeps using the address it was opened through.

The image command is:

```text
kanban --host :: --no-open --no-passcode --skip-shutdown-cleanup
```

It deliberately has **no `--port` argument**. The CLI defaults to **3484**. An installation can override that with
`KANBAN_RUNTIME_PORT` (or its own explicit CLI `--port`). `EXPOSE 3484` is descriptive metadata, not a runtime port
selection. Publish the actual chosen container/pod port in the installation's network configuration; changing an
environment variable does not change a Podman/Docker port mapping.

For Quadlet containers that join a shared Podman pod, put `PublishPort=3484:3484` (or the installation's chosen
mapping) in the pod's `.pod` file, not a member's `.container` file. The application must listen on the mapped pod
port on external interfaces; publishing a port does not forward to a different port or to a loopback-only listener.

The image uses `::`, the Linux dual-stack wildcard, to accept both IPv4 and IPv6. A rootless Podman wildcard
publisher can accept `localhost` on IPv6 (`::1`) even when the application binds only IPv4 (`0.0.0.0`); that produces
a connection reset rather than an IPv4 fallback. Explicitly publishing on `0.0.0.0` did not avoid that behavior in
the verified deployment. Test `localhost`, `127.0.0.1` and `[::1]`, not just the IPv4 address. Runtime HTTP/WebSocket
URL builders bracket IPv6 literals while retaining the raw address for the listener and lifecycle environment.
An installation that disables IPv6 can explicitly override the image command with `--host 0.0.0.0` and use IPv4.

Caddy is optional for deployments that want its TLS/reverse-proxy features. Kanban can serve HTTP directly, or HTTPS
with explicit `--cert` and `--key`. The image's existing `--no-passcode` is an installation choice; authentication
and caller authorization are separate from the removed host/origin allow-lists.

The entrypoint's lifecycle helpers retain the same command/env-resolved home and endpoint. A separately invoked
`podman exec` maintenance command needs the installation's runtime port explicitly if it differs from the CLI
default; environment changes made inside the running server do not propagate back to the container's exec env.

## Distribution services

- **Kanban container:** the application and agent CLIs; Kanban's own state is in its canonical home.
- **Headless Chrome sidecar:** the shared browser for agents and Playwright tests (npm package only; CDP attachment).
- **Caddy:** optional deployment component.
- **Database services:** application/project dependencies. A shared Postgres sidecar is optional infrastructure for
  projects choosing PostgreSQL, not a required Kanban datastore. Database engine and connection-secret references
  belong to project configuration; one shared service does not force every project to use it.

AI/provider endpoint URLs are installation-specific. The AI pod retains container-to-host port mappings; host
networking is not assumed. Configure reachable MagicDNS addresses for Lemonade and Triton, including their mapped
ports. No provider hostname or host-network requirement is baked into the product distribution.
