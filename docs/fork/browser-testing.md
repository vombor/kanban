# Browser testing with the shared Chrome sidecar

Install the Playwright npm package from `web-ui`'s dependencies. Do **not** run `playwright install`, install a
headless Chrome dependency, or launch another browser. Product tests and agents use the installation's existing
headless Chrome sidecar.

Every spec imports `test` from `web-ui/tests/shared-chrome.ts`. That fixture attaches with
`chromium.connectOverCDP(process.env.PLAYWRIGHT_CDP_URL ?? "http://127.0.0.1:9222")`. Normal Playwright per-test
contexts remain isolated. Teardown closes those contexts and disconnects its CDP transport; it does not shut down
the sidecar or close agent tabs. Tests must not use the shared browser's default context.

Mobile tests start throwaway Kanban/Vite instances through `tests/mobile/dev-instance.ts`: separate HOME, Kanban
home, projects root, runtime and Vite ports, with inherited `KANBAN_*`/git redirection removed. Terminal probes use
fake CLIs and real CDP touch/IME events. `disableWebGL: true` disables WebGL only in that test context when a test
needs xterm's DOM renderer; no shared browser launch flag changes are required.

## Running inside the pod network

When the runner already shares the sidecar's network namespace:

```sh
npm --prefix web-ui run e2e:mobile -- project-settings.spec.ts
```

For host development, keep the checkout and temporary homes on the host, and join the existing pod network:

```sh
chrome_pid=$(podman inspect --format '{{.State.Pid}}' "$CHROME_CONTAINER")
podman unshare nsenter --target "$chrome_pid" --net \
  "$NODE_EXECUTABLE" "$CHECKOUT/web-ui/node_modules/@playwright/test/cli.js" \
  test --config "$CHECKOUT/web-ui/playwright.mobile.config.ts" project-settings.spec.ts
```

Set `CHROME_CONTAINER`, `NODE_EXECUTABLE` and `CHECKOUT` for the installation. Launch from the checkout so the
test runner resolves relative paths there; ensure the Node executable's directory is on PATH for test child
processes. A sandboxed host shell can invoke the same command through `flatpak-spawn --host`. Only the network
namespace changes, so the throwaway runtime/Vite listen on the same loopback Chrome sees and their files remain
in host temporary directories. No extra CDP port is published, and the live Kanban runtime is not restarted.

An externally reachable CDP endpoint can instead be supplied with `PLAYWRIGHT_CDP_URL`. In that case the browser
also needs network access to the throwaway app; a driver-local `localhost` app is not the remote browser's localhost.
