// CI validates an owned disposable product image without host homes/projects, credentials or live pod access.
import { spawnSync } from "node:child_process";
import { PRODUCT_SMOKE_PROBE } from "./product-smoke-probe.mjs";

const [engine = "docker", image] = process.argv.slice(2);
if (!image || !["docker", "podman"].includes(engine)) throw new Error("Usage: node scripts/container-smoke.mjs <docker|podman> <image>");
const result = spawnSync(engine, ["run", "--rm", "--network=none", image, "node", "-e", PRODUCT_SMOKE_PROBE], { stdio: "inherit", timeout: 180_000 });
process.exitCode = result.status ?? 1;
