// Validate a disposable product image, with no host home/project mounts, credentials, ports or live pod access.
import { spawnSync } from "node:child_process";

const [engine = "docker", image] = process.argv.slice(2);
if (!image) throw new Error("Usage: node scripts/container-smoke.mjs <docker|podman> <image>");
const probe = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {spawn, spawnSync} = require("node:child_process");
const {createRequire} = require("node:module");
const path = require("node:path");
const requireProduct = createRequire("/usr/local/lib/node_modules/@vombor/kanban/package.json");
const pty = requireProduct("node-pty");
const home = "/tmp/kanban-product-smoke";
const port = 3485;
const env = {...process.env, KANBAN_HOME: home, KANBAN_RUNTIME_PORT: String(port), KANBAN_PROJECTS_ROOTS: "/projects"};
let runtime;
let output = "";
function command(binary, args, cwd = "/projects") {
  const result = spawnSync(binary, args, {env, cwd, encoding: "utf8", timeout: 30000});
  assert.equal(result.status, 0, binary + " failed: " + result.stderr + result.stdout);
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
  runtime = spawn("kanban-entrypoint", ["kanban", "--home", home, "--port", String(port), "--no-open", "--no-passcode"], {env: {...env, KANBAN_HOME: "/tmp/ignored-home"}, stdio: ["ignore", "pipe", "pipe"]});
  runtime.stdout.on("data", data => {output += data;});
  runtime.stderr.on("data", data => {output += data;});
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(runtime.exitCode, null, "Runtime exited: " + output);
    try {if ((await fetch("http://127.0.0.1:" + port)).ok) {ready = true; break;}} catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, "Runtime did not start: " + output);
  const projects = await (await fetch("http://127.0.0.1:" + port + "/api/trpc/projects.list")).json();
  assert.deepEqual(projects.result.data.projects, [], "New instances must have no projects");
  assert.ok(!fs.existsSync("/tmp/ignored-home"), "--home must win everywhere, including lifecycle helpers");
  const setup = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "setup", "--json"]));
  assert.equal(setup.ok, true, "Explicit instance setup failed");
  const created = JSON.parse(command("kanban", ["--home", home, "--port", String(port), "project", "create", "/projects/first-project", "--kit", "default", "--json"]));
  assert.equal(created.ok, true, "The user must be able to create the first project");
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.ok(!config.providers || !("setupWorkspaceId" in config.providers), "Creating the first project must not grant privileges");
  runtime.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {runtime.kill("SIGKILL"); reject(new Error("Shutdown timed out: " + output));}, 30000);
    runtime.once("exit", code => {clearTimeout(timer); try {assert.equal(code, 0, output); resolve();} catch(error) {reject(error);}});
  });
  assert.match(output, /restart prepare done/, "Lifecycle restart prepare must reach this home and server");
  console.log(JSON.stringify({user: "node", globalPrefix: "/usr/local", agentClis: "all executable", projectInstall: true, nativePty: true, initialProjects: 0, firstProjectPrivileged: false, explicitSetup: true, customKanbanHome: true, gracefulStop: true}));
}
main().catch(error => {if (runtime && runtime.exitCode === null) runtime.kill("SIGKILL"); console.error(error.message); process.exitCode = 1;});
`;
const result = spawnSync(engine, ["run", "--rm", "--network=none", image, "node", "-e", probe], {
	stdio: "inherit",
	timeout: 180_000,
});
process.exitCode = result.status ?? 1;
