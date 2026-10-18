import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";

import { renameDurably, writeFileSynced } from "../../../src/fs/durable-file";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { journalSchema, type MaintenanceJournal } from "./contracts";
import { getMaintenancePaths } from "./paths";

export class MaintenanceJournalError extends Error {}

export class MaintenanceStore {
	readonly paths;
	constructor(home?: string) {
		this.paths = getMaintenancePaths(home);
	}

	async read(): Promise<MaintenanceJournal> {
		try {
			if ((await lstat(this.paths.journal)).isSymbolicLink())
				throw new MaintenanceJournalError("Maintenance journal is a symlink; refusing it");
			const source = await readFile(this.paths.journal, "utf8");
			if (Buffer.byteLength(source) > 8 * 1024 * 1024)
				throw new MaintenanceJournalError("Maintenance journal exceeds its bounded size");
			return journalSchema.parse(JSON.parse(source));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return { version: 1, revision: 0, jobs: [], checks: [], events: [] };
			throw new MaintenanceJournalError(
				"Maintenance journal is unreadable/corrupt; preserve it and inspect, never reset or replay admissions",
			);
		}
	}

	async transaction<T>(operation: (journal: MaintenanceJournal, save: () => Promise<void>) => Promise<T>): Promise<T> {
		await mkdir(this.paths.root, { recursive: true, mode: 0o700 });
		if ((await lstat(this.paths.root)).isSymbolicLink())
			throw new MaintenanceJournalError("Maintenance root may not be a symlink");
		await chmod(this.paths.root, 0o700);
		return await lockedFileSystem.withLock({ path: this.paths.journal, staleMs: 60_000, retries: 0 }, async () => {
			const journal = await this.read();
			let persisted = JSON.stringify(journal);
			const save = async () => {
				if (JSON.stringify(journal) === persisted) return;
				journal.revision += 1;
				const content = `${JSON.stringify(journalSchema.parse(journal), null, 2)}\n`;
				if (Buffer.byteLength(content) > 8 * 1024 * 1024)
					throw new MaintenanceJournalError("Maintenance journal ceiling reached; no history was evicted");
				const temporary = `${this.paths.journal}.${randomUUID()}.tmp`;
				await writeFileSynced(temporary, content, { mode: 0o600, flag: "wx" });
				await renameDurably(temporary, this.paths.journal);
				persisted = JSON.stringify(journal);
			};
			return await operation(journal, save);
		});
	}
}
