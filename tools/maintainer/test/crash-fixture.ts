// Executed ONLY by the owned-process crash regression, never by the test runner directly.
import { maintenanceConfigSchema } from "../src/contracts";
import { MaintenanceStore } from "../src/store";
import { MaintenanceSupervisor } from "../src/supervisor";

const home = process.env.MAINTENANCE_TEST_HOME;
if (!home) throw new Error("Crash fixture requires its own temporary home");
const config = maintenanceConfigSchema.parse({
	version: 1,
	repository: "example/project",
	projectDirectory: "/fixture",
	branch: "main",
	sessionId: "ses_fixture",
	opencodeCli: "/fixture/opencode",
	githubBridge: { executable: "/fixture/bridge", args: [] },
	timezone: "UTC",
	requiredWorkflows: ["checks.yml"],
});
const keepAlive = setInterval(() => {}, 1000);
await new MaintenanceSupervisor(config, new MaintenanceStore(home), {
	now: () => new Date("2026-10-17T10:00:00Z"),
	startingCommit: async () => "a".repeat(40),
	issues: async () => [{ number: 7, materialHash: "c".repeat(64), comments: [] }],
	validateTarget: async () => {},
	submit: async () => {
		process.stdout.write("reserved\n");
		await new Promise(() => {});
	},
	observe: async () => {
		throw new Error("Unexpected observation");
	},
	verify: async () => {
		throw new Error("Unexpected verification");
	},
}).daily("2026-10-17");
clearInterval(keepAlive);
