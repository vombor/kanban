// Shared product checks; executes only inside an owned disposable container, never a live instance.
export const PRODUCT_SMOKE_PROBE = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {spawn, spawnSync} = require("node:child_process");
const {createRequire} = require("node:module");
const path = require("node:path");
const requireProduct = createRequire("/usr/local/lib/node_modules/@vombor/kanban/package.json");
const pty = requireProduct("node-pty");
const WebSocket = requireProduct("ws");
const home = "/tmp/kanban-product-smoke";
// Exercise the installation's env override: neither the image CMD nor this launch pins --port.
const port = 3497;
const env = {...process.env, KANBAN_HOME: home, KANBAN_RUNTIME_HOST: "::", KANBAN_RUNTIME_PORT: String(port), KANBAN_PROJECTS_ROOTS: "/projects"};
let runtime;
let output = "";
function killRuntimeGroup() {
  if (!runtime || !runtime.pid) return;
  try {process.kill(-runtime.pid, "SIGKILL");}
  catch (error) {if (error.code !== "ESRCH") throw error;}
}
function command(binary, args, cwd = "/projects") {
  const result = spawnSync(binary, args, {env, cwd, encoding: "utf8", timeout: 30000});
  assert.equal(result.status, 0, binary + " " + args.join(" ") + " failed: " + result.stderr + result.stdout);
  return result.stdout;
}
async function main() {
  assert.equal(process.getuid(), 1000, "The normal image runtime must be node");
  assert.equal(process.env.KANBAN_UPDATE_MODE, "image");
  assert.equal(process.env.KANBAN_HOME, path.join(process.env.HOME, ".kanban"));
  assert.ok(!fs.existsSync(path.join(process.env.HOME, ".npmrc")), "Startup must not bootstrap npm");
  assert.ok(!fs.existsSync(path.join(process.env.HOME, ".gitconfig")), "Startup must not bootstrap git");
  for (const binary of ["kanban", "claude", "codex", "cline", "copilot", "droid"]) command(binary, ["--version"]);
  assert.equal(command("npm", ["prefix", "-g"]).trim(), "/usr/local");
  fs.mkdirSync("/projects/npm-probe", {recursive: true});
  fs.writeFileSync("/projects/npm-probe/package.json", JSON.stringify({name: "npm-probe", version: "1.0.0"}));
  command("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], "/projects/npm-probe");
  await new Promise((resolve, reject) => {
    let text = "";
    const terminal = pty.spawn("sh", ["-c", "printf PTY_OK"], {cwd: "/projects", env});
    terminal.onData(data => {text += data;});
    terminal.onExit(({exitCode}) => {try {assert.equal(exitCode, 0); assert.match(text, /PTY_OK/); resolve();} catch(error) {reject(error);}});
  });
  fs.mkdirSync(home, {recursive: true});
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({agents: {cline: {lemonadeContextSync: {mode: "off"}}}}));
  runtime = spawn("kanban-entrypoint", ["kanban", "--home", home, "--host", "::", "--no-open", "--no-passcode"], {env: {...env, KANBAN_HOME: "/tmp/ignored-home"}, detached: true, stdio: ["ignore", "pipe", "pipe"]});
  runtime.stdout.on("data", data => {output += data;});
  runtime.stderr.on("data", data => {output += data;});
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(runtime.exitCode, null, "Runtime exited: " + output);
    try {if ((await fetch("http://127.0.0.1:" + port)).ok) {ready = true; break;}} catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, "Runtime did not start: " + output);
  for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
    const origin = "http://" + host + ":" + port;
    const response = await fetch(origin + "/api/passcode/status");
    assert.equal(response.status, 200, "HTTP must reach " + host);
    assert.equal((await response.json()).required, false);
    await new Promise((resolve, reject) => {
      let opened = false;
      const socket = new WebSocket(origin.replace("http:", "ws:") + "/api/runtime/ws", {headers: {Origin: "https://different.example.test"}});
      const timer = setTimeout(() => {socket.terminate(); reject(new Error("WebSocket timed out for " + host));}, 5000);
      socket.once("error", error => {clearTimeout(timer); reject(error);});
      socket.once("open", () => {opened = true; socket.close();});
      socket.once("close", () => {clearTimeout(timer); opened ? resolve() : reject(new Error("WebSocket did not open for " + host));});
    });
  }
  const projectsResponse = await fetch("http://127.0.0.1:" + port + "/api/trpc/projects.list");
  const projects = await projectsResponse.json();
  assert.ok(projectsResponse.ok && projects.result, "Initial project list failed: " + JSON.stringify(projects));
  assert.deepEqual(projects.result.data.projects, [], "New instances must have no projects");
  assert.ok(!fs.existsSync("/tmp/ignored-home"), "--home must win everywhere, including lifecycle helpers");
  const setup = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "setup", "--json"]));
  assert.equal(setup.ok, true, "Explicit instance setup failed");
  const created = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "project", "create", "/projects/first-project", "--kit", "default", "--json"]));
  assert.equal(created.ok, true, "The user must be able to create the first project");
  if (process.env.KANBAN_SMOKE_OBJECTIVES === "1") {
    command("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "-C", "/projects/first-project", "commit", "--allow-empty", "-m", "Owned smoke initial state"]);
    const task = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "task", "create", "--project-path", "/projects/first-project", "--title", "Native objective fixture", "--prompt", "Keep user work and pass the regression"]));
    assert.equal(task.ok, true);
    const requirements = "Keep user work and pass the regression";
    fs.writeFileSync("/tmp/objective-requirements.md", requirements);
    const objective = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "objective", "create", "Native objective fixture", "--project", "/projects/first-project", "--file", "/tmp/objective-requirements.md", "--task", task.task.id, "--json"]));
    assert.equal(objective.status, "awaiting_evidence");
    assert.equal(objective.estimatedUsd, null);
    assert.equal(objective.limits.mode, "report");
    const pinned = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "objective", "read", objective.id, "--project", "/projects/first-project", "--json"]));
    assert.equal(pinned.requirements, requirements);
    assert.equal(pinned.objective.requirementsHash, require("node:crypto").createHash("sha256").update(requirements).digest("hex"));
    assert.equal(pinned.admissionScopeAvailable, true);
    assert.equal(pinned.handoffGuide.executionEnforcementAvailable, true);
    const refreshed = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "objective", "recheck", objective.id, "--project", "/projects/first-project", "--json"]));
    assert.notEqual(refreshed.objective.status, "completed", "Recheck must not invent completion or execute work");
    assert.deepEqual(refreshed.objective.attempts, []);
    const limited = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "objective", "limits", objective.id, "--project", "/projects/first-project", "--revision", String(refreshed.objective.revision), "--attempts", "3", "--minutes", "10", "--usd", "0.01", "--json"]));
    assert.equal(limited.limits.mode, "report");
    assert.equal(limited.limits.maxAttempts, 3);
    assert.equal(limited.estimatedUsd, null);
    assert.equal(limited.costCoverage, "unknown");
    assert.equal(limited.requirementsHash, objective.requirementsHash);
    const refusal = spawnSync("kanban", ["--home", home, "--port", String(port), "objective", "limits", objective.id, "--project", "/projects/first-project", "--revision", String(limited.revision), "--mode", "enforce", "--json"], { env, cwd: "/projects", encoding: "utf8", timeout: 30000 });
    assert.notEqual(refusal.status, 0, "Partial hooks must never enable enforcement");
    assert.match(refusal.stderr, /report mode only/);
    const enforced = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "objective", "limits", objective.id, "--project", "/projects/first-project", "--revision", String(limited.revision), "--mode", "enforce", "--acknowledge-admission-scope", "--json"]));
    assert.equal(enforced.limits.mode, "enforce");
    const held = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "objective", "read", objective.id, "--project", "/projects/first-project", "--json"]));
    assert.ok(held.admissionStates.every(row => !row.allowed && row.reason === "cost_unknown"), "Unknown cost must never become zero or unacknowledged admission");
    const paused = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "objective", "pause", objective.id, "--project", "/projects/first-project", "--revision", String(held.objective.revision), "--reason", "Owned smoke: block new admission, preserve active work", "--json"]));
    assert.equal(paused.pausedByUser, true);
    const resumed = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "objective", "resume", objective.id, "--project", "/projects/first-project", "--revision", String(paused.revision), "--reason", "Owned smoke: eligibility only, never replay work", "--json"]));
    assert.equal(resumed.pausedByUser, false);
    assert.deepEqual(resumed.attempts, []); assert.deepEqual(resumed.reservations, []); assert.equal(resumed.estimatedUsd, null);
    assert.ok(!fs.existsSync("/usr/local/lib/node_modules/@vombor/kanban/dist/maintenance.js"), "Maintainer tooling must not ship in product dist");
  }
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.ok(!config.providers || !("setupWorkspaceId" in config.providers), "Creating the first project must not grant privileges");
  runtime.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {killRuntimeGroup(); reject(new Error("Shutdown timed out: " + output));}, 30000);
    runtime.once("exit", code => {clearTimeout(timer); try {assert.equal(code, 0, output); resolve();} catch(error) {reject(error);}});
  });
  assert.match(output, /restart prepare done/, "Lifecycle restart prepare must reach this home and server");
  console.log(JSON.stringify({user: "node", globalPrefix: "/usr/local", agentClis: "all executable", projectInstall: true, nativePty: true, dualStackHttpAndWebSocket: true, initialProjects: 0, firstProjectPrivileged: false, explicitSetup: true, customKanbanHome: true, gracefulStop: true}));
}
main().catch(error => {killRuntimeGroup(); console.error(error.message); process.exitCode = 1;});
`;
