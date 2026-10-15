// Auto-unlocking local encrypted vault. Values are never returned by the agent/browser metadata API or added to PTY env.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { renameDurably, writeFileSynced } from "../fs/durable-file";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	getKanbanDataPath,
	getKanbanHomePath,
	getKanbanSecretsPath,
	getProjectSecretsPath,
} from "../state/kanban-home";
import {
	type ProjectSecretInput,
	type ProjectSecretMetadata,
	projectSecretMetadataSchema,
	projectSecretNameSchema,
	projectSecretsWriteSchema,
} from "../trpc/project-secrets-contract";

const cipherSchema = projectSecretMetadataSchema.extend({ iv: z.string(), tag: z.string(), ciphertext: z.string() });
const vaultSchema = z
	.object({ version: z.literal(1), scope: z.string(), secrets: z.record(z.string(), cipherSchema) })
	.strict();
type Vault = z.infer<typeof vaultSchema>;
export interface ProjectSecretVault {
	/** Offline rename-id after moving the project data directory; idempotently rebinds authenticated encryption. */
	rebind: (fromWorkspaceId: string, toWorkspaceId: string) => Promise<void>;
	list: (workspaceId: string) => Promise<ProjectSecretMetadata[]>;
	set: (workspaceId: string, secrets: ProjectSecretInput[]) => Promise<ProjectSecretMetadata[]>;
	remove: (workspaceId: string, name: string) => Promise<ProjectSecretMetadata[]>;
	/** Server-owned consumer boundary only; never expose this as a plaintext RPC/CLI. */
	withValues: <T>(
		workspaceId: string,
		names: readonly string[],
		consumer: (values: Readonly<Record<string, string>>) => Promise<T>,
	) => Promise<T>;
}
export function createProjectSecretVault(options: { homePath?: string; now?: () => Date } = {}): ProjectSecretVault {
	const home = options.homePath ?? getKanbanHomePath();
	const keyPath = join(getKanbanSecretsPath(home), "project-vault-key");
	const pathOf = (workspaceId: string) => getProjectSecretsPath(workspaceId, home);
	let key: Buffer | null = null;
	// Key creation is installation-wide, not just a decision about the project being edited.
	const hasEncryptedRecords = async () => {
		try {
			const dataPath = getKanbanDataPath(home);
			const entries = await readdir(dataPath, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				let text: string;
				try {
					text = await readFile(join(dataPath, entry.name, "project-secrets.json"), "utf8");
				} catch (error) {
					if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
					throw error;
				}
				const vault = vaultSchema.parse(JSON.parse(text));
				if (Object.keys(vault.secrets).length > 0) return true;
			}
			return false;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
			throw new Error("Could not inspect existing project secret vaults");
		}
	};
	const getKey = async (allowCreate: boolean) => {
		if (key) return key;
		await mkdir(getKanbanSecretsPath(home), { recursive: true, mode: 0o700 });
		return await lockedFileSystem.withLock({ path: keyPath }, async () => {
			let loaded: Buffer;
			try {
				loaded = await readFile(keyPath);
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
					throw new Error("Could not initialize the project secret vault");
				if (!allowCreate || (await hasEncryptedRecords()))
					throw new Error("The project secret vault key is missing");
				loaded = randomBytes(32);
				const temp = `${keyPath}.${process.pid}.tmp`;
				await writeFileSynced(temp, loaded, { mode: 0o600 });
				await renameDurably(temp, keyPath);
			}
			if (loaded.length !== 32) throw new Error("The project secret vault key is damaged");
			await chmod(keyPath, 0o600);
			key = loaded;
			return key;
		});
	};
	const read = async (workspaceId: string, allowPriorScope?: string): Promise<Vault> => {
		try {
			const vault = vaultSchema.parse(JSON.parse(await readFile(pathOf(workspaceId), "utf8")));
			if (vault.scope !== workspaceId && vault.scope !== allowPriorScope)
				throw new Error("Wrong project secret scope");
			return vault;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
				return { version: 1, scope: workspaceId, secrets: {} };
			throw new Error("Could not read the project's encrypted secret vault");
		}
	};
	const metadata = (vault: Vault) =>
		Object.values(vault.secrets)
			.map(({ name, updatedAt }) => ({ name, updatedAt, configured: true as const }))
			.sort((a, b) => a.name.localeCompare(b.name));
	const write = async (workspaceId: string, vault: Vault) => {
		const path = pathOf(workspaceId),
			temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			await writeFileSynced(temp, `${JSON.stringify(vault, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
			await renameDurably(temp, path);
		} finally {
			await rm(temp, { force: true });
		}
	};
	const decrypt = (workspaceId: string, name: string, secret: z.infer<typeof cipherSchema>, master: Buffer) => {
		try {
			const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(secret.iv, "base64"));
			decipher.setAAD(Buffer.from(`${workspaceId}:${name}`));
			decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
			return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString(
				"utf8",
			);
		} catch {
			throw new Error("Could not decrypt the project's secret vault");
		}
	};
	const encrypt = (
		workspaceId: string,
		name: string,
		value: string,
		updatedAt: string,
		master: Buffer,
	): z.infer<typeof cipherSchema> => {
		const iv = randomBytes(12),
			cipher = createCipheriv("aes-256-gcm", master, iv);
		cipher.setAAD(Buffer.from(`${workspaceId}:${name}`));
		const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
		return {
			name,
			configured: true,
			updatedAt,
			iv: iv.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			ciphertext: encrypted.toString("base64"),
		};
	};
	return {
		rebind: async (fromWorkspaceId, toWorkspaceId) => {
			pathOf(fromWorkspaceId);
			await lockedFileSystem.withLock({ path: pathOf(toWorkspaceId) }, async () => {
				const vault = await read(toWorkspaceId, fromWorkspaceId);
				if (vault.scope === toWorkspaceId) return;
				const master = await getKey(false);
				const rebound: Vault = { version: 1, scope: toWorkspaceId, secrets: {} };
				for (const [name, secret] of Object.entries(vault.secrets)) {
					rebound.secrets[name] = encrypt(
						toWorkspaceId,
						name,
						decrypt(fromWorkspaceId, name, secret, master),
						secret.updatedAt,
						master,
					);
				}
				await write(toWorkspaceId, rebound);
			});
		},
		list: async (workspaceId) => metadata(await read(workspaceId)),
		set: async (workspaceId, inputs) => {
			const secrets = projectSecretsWriteSchema.parse({ secrets: inputs }).secrets;
			return await lockedFileSystem.withLock({ path: pathOf(workspaceId) }, async () => {
				const vault = await read(workspaceId),
					master = await getKey(Object.keys(vault.secrets).length === 0);
				for (const { name, value } of secrets) {
					vault.secrets = {
						...vault.secrets,
						[name]: encrypt(workspaceId, name, value, (options.now?.() ?? new Date()).toISOString(), master),
					};
				}
				await write(workspaceId, vault);
				return metadata(vault);
			});
		},
		remove: async (workspaceId, name) => {
			projectSecretNameSchema.parse(name);
			return await lockedFileSystem.withLock({ path: pathOf(workspaceId) }, async () => {
				const vault = await read(workspaceId);
				delete vault.secrets[name];
				await write(workspaceId, vault);
				return metadata(vault);
			});
		},
		withValues: async (workspaceId, names, consumer) => {
			const vault = await read(workspaceId),
				master = await getKey(false),
				values: Record<string, string> = {};
			for (const name of names) {
				projectSecretNameSchema.parse(name);
				const secret = Object.hasOwn(vault.secrets, name) ? vault.secrets[name] : undefined;
				if (!secret) throw new Error(`Project secret ${name} is not configured`);
				values[name] = decrypt(workspaceId, name, secret, master);
			}
			try {
				return await consumer(values);
			} catch {
				throw new Error("Project secret consumer failed");
			} finally {
				for (const name of Object.keys(values)) delete values[name];
			}
		},
	};
}
