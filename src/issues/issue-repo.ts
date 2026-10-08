// Which repository a project imports issues from. Project isolation: a project only ever reaches its own remote, so
// the repository is derived from the project's `origin` remote, and a configured `issues.repo` is refused unless it is
// one of the project's own git remotes (ssh and https forms both count). A host other than the provider's never
// matches, so a remote on another forge can't be named either.
import type { IssueProviderId } from "../config/pipeline-config";
import { runGit } from "../workspace/git-utils";

export interface GitRemote {
	name: string;
	url: string;
}

export interface ParsedRemoteUrl {
	host: string;
	/** `owner/name`, without `.git`. */
	repo: string;
}

const PROVIDER_HOSTS: Record<IssueProviderId, readonly string[]> = {
	github: ["github.com", "www.github.com", "ssh.github.com"],
};

function toRepoPath(path: string): string | null {
	const trimmed = path
		.replace(/^\/+/u, "")
		.replace(/\/+$/u, "")
		.replace(/\.git$/u, "");
	const parts = trimmed.split("/");
	if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== "..")) {
		return null;
	}
	return `${parts[0]}/${parts[1]}`;
}

/**
 * Parses a git remote URL: `git@host:owner/name(.git)`, `ssh://[user@]host[:port]/owner/name`,
 * `https://[user@]host/owner/name(.git)`, `git://host/owner/name`. Null for anything else (a local path, a bundle).
 */
export function parseGitRemoteUrl(url: string): ParsedRemoteUrl | null {
	const value = url.trim();
	const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/u.exec(value);
	if (scp?.[1] && scp[2] && !/^[A-Za-z]:\\/u.test(value)) {
		const repo = toRepoPath(scp[2]);
		return repo ? { host: scp[1].toLowerCase(), repo } : null;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (!["ssh:", "https:", "http:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) {
		return null;
	}
	const repo = toRepoPath(decodeURIComponent(parsed.pathname));
	return repo ? { host: parsed.hostname.toLowerCase(), repo } : null;
}

/** The project's remotes (`git remote -v`, fetch URLs). */
export async function listGitRemotes(repoPath: string): Promise<GitRemote[]> {
	const result = await runGit(repoPath, ["remote", "-v"]);
	if (!result.ok) {
		return [];
	}
	const remotes = new Map<string, string>();
	for (const line of result.stdout.split("\n")) {
		const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/u.exec(line.trim());
		if (match?.[1] && match[2] && !remotes.has(match[1])) {
			remotes.set(match[1], match[2]);
		}
	}
	return [...remotes].map(([name, url]) => ({ name, url }));
}

/** The provider's repositories among the remotes, by remote name. */
export function listProviderRepos(
	provider: IssueProviderId,
	remotes: readonly GitRemote[],
): Array<{ remote: string; repo: string }> {
	const hosts = PROVIDER_HOSTS[provider];
	return remotes.flatMap((remote) => {
		const parsed = parseGitRemoteUrl(remote.url);
		return parsed && hosts.includes(parsed.host) ? [{ remote: remote.name, repo: parsed.repo }] : [];
	});
}

export type IssueRepoResolution =
	| { ok: true; repo: string; remote: string; source: "origin" | "config" }
	| { ok: false; error: string };

/** The repository to import from: `configured` when it is one of the project's remotes, else `origin`'s. */
export function resolveIssueRepo(input: {
	provider: IssueProviderId;
	configured: string | null;
	remotes: readonly GitRemote[];
}): IssueRepoResolution {
	const candidates = listProviderRepos(input.provider, input.remotes);
	const known = candidates.map((candidate) => `${candidate.repo} (${candidate.remote})`).join(", ") || "none";
	if (input.configured) {
		const wanted = input.configured
			.trim()
			.replace(/\.git$/u, "")
			.toLowerCase();
		const match = candidates.find((candidate) => candidate.repo.toLowerCase() === wanted);
		return match
			? { ok: true, repo: match.repo, remote: match.remote, source: "config" }
			: {
					ok: false,
					error: `issues.repo "${input.configured}" is not one of this project's ${input.provider} remotes (${known}); a project imports issues only from its own repository`,
				};
	}
	const origin = candidates.find((candidate) => candidate.remote === "origin");
	if (origin) {
		return { ok: true, repo: origin.repo, remote: "origin", source: "origin" };
	}
	return {
		ok: false,
		error: `the project's origin remote is not a ${input.provider} repository (its ${input.provider} remotes: ${known}); set issues.repo to one of them`,
	};
}

/**
 * The repository with the first sync's pin applied. Worktrees share `.git/config`, so a card can run `git remote
 * set-url origin …`; a repository derived from origin that differs from the pinned one is refused until the user
 * names it in `issues.repo`. `pin` says whether the caller should (re)write the pin.
 */
export function resolvePinnedIssueRepo(input: {
	provider: IssueProviderId;
	configured: string | null;
	remotes: readonly GitRemote[];
	pinned: { repo: string } | null;
}): (IssueRepoResolution & { ok: false }) | (Extract<IssueRepoResolution, { ok: true }> & { pin: boolean }) {
	const resolved = resolveIssueRepo(input);
	if (!resolved.ok) {
		return resolved;
	}
	const same = input.pinned?.repo.toLowerCase() === resolved.repo.toLowerCase();
	if (resolved.source === "config" || !input.pinned) {
		return { ...resolved, pin: !same };
	}
	if (!same) {
		return {
			ok: false,
			error: `origin now points at ${resolved.repo}, but this project's issue import was pinned to ${input.pinned.repo} on its first sync (task worktrees share .git/config, so a card can change origin); set issues.repo to the repository to import from`,
		};
	}
	return { ...resolved, pin: false };
}
