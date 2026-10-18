import type {
	ExecutionObservation,
	IssueSnapshot,
	MaintenanceConfig,
	MaintenanceJob,
	Verification,
	WorkerResult,
} from "./contracts";

export interface MaintenancePorts {
	now: () => Date;
	startingCommit: () => Promise<string>;
	issues: () => Promise<IssueSnapshot[]>;
	validateTarget: () => Promise<void>;
	submit: (job: MaintenanceJob, text: string) => Promise<void>;
	observe: (job: MaintenanceJob) => Promise<ExecutionObservation>;
	verify: (job: MaintenanceJob, result: WorkerResult) => Promise<Verification>;
}

export type CommandRunner = (config: {
	executable: string;
	args: string[];
	cwd?: string;
	input?: string;
	maxBytes?: number;
}) => Promise<{ status: number; stdout: string; stderr: string }>;

export interface ConfiguredMaintenancePorts {
	config: MaintenanceConfig;
	ports: MaintenancePorts;
}
