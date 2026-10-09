import { describe, expect, it } from "vitest";

import { DEFAULT_GUARDRAIL_DENY_COMMANDS } from "../../../src/config/pipeline-config";
import {
	allowOwnBranchPush,
	describeDeniedCommand,
	expandDeniedCommandRule,
	findDeniedCommand,
	hasSharedRefspec,
	isSharedRefDestination,
	listShellCommands,
	PLAN_APPROVAL_DENY_COMMANDS,
	parseDeniedCommandPatterns,
	pushMayUpdateSharedBranch,
	splitShellCommandLine,
} from "../../../src/guardrails/command-patterns";

const rules = parseDeniedCommandPatterns(DEFAULT_GUARDRAIL_DENY_COMMANDS, ["main", "fork/stack"]);

function denied(commandLine: string): string | null {
	return findDeniedCommand(commandLine, rules)?.rule.pattern ?? null;
}

describe("denied-command patterns", () => {
	it("parses alternatives and expands {shared} to each branch by name and as a ref", () => {
		const [rule] = parseDeniedCommandPatterns(["git branch -D|--delete {shared}"], ["main", "refs/heads/fork/stack"]);
		expect(rule?.words).toEqual([
			["git"],
			["branch"],
			["-D", "--delete"],
			["main", "refs/heads/main", "fork/stack", "refs/heads/fork/stack"],
		]);
		// `git branch` is the head; the option slot and {shared} float.
		expect(rule?.headLength).toBe(2);
		expect(parseDeniedCommandPatterns(["systemctl --user restart|stop"], [])[0]?.headLength).toBe(3);
		// {shared-push} only after `git push`.
		expect(parseDeniedCommandPatterns(["git fetch {shared-push}"], ["main"])).toEqual([]);
		expect(rule ? expandDeniedCommandRule(rule) : []).toHaveLength(8);
		// No shared branches: a {shared} rule stands for nothing, so it is dropped.
		expect(parseDeniedCommandPatterns(["git update-ref {shared}", " "], [])).toEqual([]);
	});

	it("denies every form of git push", () => {
		for (const command of [
			"git push",
			"git push --force origin HEAD:fork/stack",
			"git push -f",
			"git push --force-with-lease origin card",
			"git -C /projects/kanban push origin main",
			"git -c user.name=x push",
			"/usr/bin/git push",
			"GIT_TRACE=1 git push",
			"sudo -E git push",
			"npm test && git push",
			"echo done; git push origin card | tee log",
			"bash -lc 'cd /projects/kanban && git push'",
			'sh -c "git push origin main"',
			"echo $(git push)",
		]) {
			expect(denied(command), command).toBe("git push");
		}
	});

	it("denies history rewrites of shared branches and keeps card-local ones allowed", () => {
		expect(denied("git update-ref refs/heads/fork/stack HEAD")).toBe("git update-ref {shared}");
		expect(denied("git update-ref -d refs/heads/main")).toBe("git update-ref {shared}");
		expect(denied("git branch -D fork/stack")).toBe("git branch -D|-d|--delete|-f|--force|-m|-M {shared}");
		expect(denied("git branch --force main HEAD~3")).toBe("git branch -D|-d|--delete|-f|--force|-m|-M {shared}");
		expect(denied("git checkout -B main")).toBe("git checkout -B {shared}");
		expect(denied("git filter-branch --all")).toBe("git filter-branch");
		expect(denied("git filter-repo --path x")).toBe("git filter-repo");
		// Card-local work: rebasing the card's own branch onto the base, resetting it, deleting its own branches.
		for (const command of [
			"git rebase fork/stack",
			"git rebase --onto fork/stack HEAD~2",
			"git reset --hard origin/fork/stack",
			"git branch -D my-card-branch",
			"git checkout fork/stack -- src/file.ts",
			"git fetch origin fork/stack",
			"git commit -m 'git push later'",
		]) {
			expect(denied(command), command).toBeNull();
		}
	});

	it("matches option slots and {shared} anywhere after the subcommand", () => {
		const branchRule = "git branch -D|-d|--delete|-f|--force|-m|-M {shared}";
		for (const [command, pattern] of [
			["git update-ref -m msg refs/heads/main X", "git update-ref {shared}"],
			["git update-ref --no-deref refs/heads/main", "git update-ref {shared}"],
			["git update-ref --stdin -z refs/heads/fork/stack", "git update-ref {shared}"],
			["git -C /projects/kanban branch -f main X", branchRule],
			["git branch -q -D main", branchRule],
			["git branch --verbose --force fork/stack HEAD~1", branchRule],
			["git branch main -f", branchRule],
			["git switch --quiet -C fork/stack", "git switch -C|--force-create {shared}"],
			["git checkout -q -B refs/heads/main", "git checkout -B {shared}"],
		] as const) {
			expect(denied(command), command).toBe(pattern);
		}
		// The option and the shared branch must both be there, as different words.
		for (const command of [
			"git branch -D card-branch",
			"git branch -f card-branch HEAD~1",
			"git branch --list main",
			"git update-ref refs/heads/card refs/heads/card-old",
			"git switch -c card origin/main",
		]) {
			expect(denied(command), command).toBeNull();
		}
		// Positional head words stay positional: `--user` is part of the subcommand here.
		expect(denied("systemctl restart --user kanban")).toBe("systemctl restart|stop|kill");
		expect(denied("systemctl --user status kanban")).toBeNull();
	});

	it("sees through wrappers and their option values", () => {
		for (const command of [
			"timeout 30 git push",
			"timeout -s KILL 30 git push",
			"sudo -u root git push",
			"nice -n 5 git push",
			"setsid git push",
			"stdbuf -o L git push",
			"git --git-dir /projects/kanban/.git --work-tree /projects/kanban push",
			"git --git-dir=/x/.git push",
			"git --config-env core.x=Y push",
		]) {
			expect(denied(command), command).toBe("git push");
		}
	});

	it("lets a PR card push its own branch, named explicitly, and nothing that may update a shared branch", () => {
		const prRules = allowOwnBranchPush(rules, ["main", "fork/stack"]);
		expect(prRules.find((rule) => rule.pattern.startsWith("git push"))?.pattern).toBe("git push {shared-push}");
		const pushDenied = (command: string) => findDeniedCommand(command, prRules)?.rule.pattern ?? null;
		for (const command of [
			"git push -u origin card-1234",
			"git push --set-upstream origin HEAD:kanban/card-1234",
			"git push -f origin card",
			"git push --force-with-lease=card:abc origin card",
			"git -C /wt/card push -o ci.skip origin HEAD:refs/heads/card",
			"git push origin v1.2.0",
			"git push --repo=origin card",
		]) {
			expect(pushDenied(command), command).toBeNull();
		}
		for (const command of [
			"git push",
			"git push origin",
			"git push -u origin HEAD",
			"git push origin @",
			"git push origin main",
			"git push origin +main",
			"git push origin HEAD:main",
			"git push origin HEAD:refs/heads/fork/stack",
			"git push origin card:main",
			// git's DWIM: `heads/main` is the remote's main.
			"git push origin card:heads/main",
			"git push origin card:refs/heads/main",
			"git push origin HEAD:heads/fork/stack",
			"git push origin heads/main",
			"git push origin +card:heads/main",
			"git push origin --delete main",
			"git push origin :fork/stack",
			"git push origin :",
			"git push --all origin",
			"git push --mirror origin",
			"git push --prune origin 'refs/heads/*:refs/heads/*'",
			"git -C /projects/kanban push origin main",
			"bash -c 'git push origin card main'",
		]) {
			expect(pushDenied(command), command).toBe("git push {shared-push}");
		}
		expect(pushMayUpdateSharedBranch(["origin", "card"], [])).toBe(false);
		// The other rules are unchanged.
		expect(prRules.filter((rule) => !rule.sharedPush)).toEqual(rules.filter((rule) => rule.pattern !== "git push"));
	});

	it("treats a destination that is or ends in /<shared> as shared", () => {
		const shared = ["main", "refs/heads/fork/stack"];
		for (const destination of [
			"main",
			"heads/main",
			"refs/heads/main",
			"refs/main",
			"fork/stack",
			"heads/fork/stack",
			"refs/heads/fork/stack",
			"refs/remotes/origin/main",
		]) {
			expect(isSharedRefDestination(destination, shared), destination).toBe(true);
		}
		for (const destination of ["card", "heads/card", "refs/heads/main-2", "domain", "stack", "fork/stack-x"]) {
			expect(isSharedRefDestination(destination, shared), destination).toBe(false);
		}
		expect(isSharedRefDestination("main", [])).toBe(false);
	});

	it("denies fetches and pulls whose refspec writes a shared branch, and keeps plain fetches allowed", () => {
		for (const command of [
			"git fetch . card:main",
			"git fetch origin main:main",
			"git fetch origin +main:refs/heads/main",
			"git fetch origin card:heads/fork/stack",
			"git fetch --update-head-ok origin main:main",
			"git -C /wt/card fetch -q origin main:main",
			"git fetch origin 'refs/heads/*:refs/heads/*'",
			"sh -c 'git fetch . HEAD:main'",
		]) {
			expect(denied(command), command).toBe("git fetch {shared-dest}");
		}
		expect(denied("git pull origin main:main")).toBe("git pull {shared-dest}");
		for (const command of [
			"git fetch",
			"git fetch origin",
			"git fetch origin main",
			"git fetch origin fork/stack",
			"git fetch --prune origin",
			"git fetch origin main:card",
			"git fetch origin main:refs/heads/card",
			"git fetch origin '+refs/heads/*:refs/remotes/origin/*'",
			"git pull origin main",
			"git pull --rebase origin fork/stack",
		]) {
			expect(denied(command), command).toBeNull();
		}
		expect(hasSharedRefspec(["--refmap=x:main", "origin"], ["main"])).toBe(false);
		const match = findDeniedCommand("git fetch . card:main", rules);
		expect(match && describeDeniedCommand(match)).toContain("git fetch origin main");
		// `{shared-dest}` stands for nothing without shared branches, and only as the last word.
		expect(parseDeniedCommandPatterns(["git fetch {shared-dest}"], [])).toEqual([]);
		expect(parseDeniedCommandPatterns(["git fetch {shared-dest} x"], ["main"])).toHaveLength(1);
		expect(parseDeniedCommandPatterns(["git fetch {shared-dest} x"], ["main"])[0]?.sharedDestination).toBeUndefined();
	});

	it("says what a PR card may push when it blocks a push", () => {
		const match = findDeniedCommand("git push origin main", allowOwnBranchPush(rules, ["main"]));
		expect(match && describeDeniedCommand(match)).toContain("This card may push only its own branch");
		const plain = findDeniedCommand("git push origin card", rules);
		expect(plain && describeDeniedCommand(plain)).toContain('matches "git push"');
		// A Commit-mode card's Make PR click: the message says how the user lets the card push.
		expect(plain && describeDeniedCommand(plain)).toContain(
			"sets the card's git action to PR and restarts its session",
		);
		const other = findDeniedCommand("git branch -D main", rules);
		expect(other && describeDeniedCommand(other)).not.toContain("git action to PR");
	});

	it("denies container and service restarts and the home migration", () => {
		expect(denied("podman restart kanban")).toBe("podman restart|stop|rm|kill");
		expect(denied("docker rm -f web")).toBe("docker restart|stop|rm|kill");
		expect(denied("systemctl --user restart kanban")).toBe("systemctl --user restart|stop|kill");
		expect(denied("systemctl stop kanban")).toBe("systemctl restart|stop|kill");
		expect(denied("kanban home migrate --dry-run")).toBe("kanban home migrate");
		expect(denied("podman ps")).toBeNull();
		expect(denied("kanban task list")).toBeNull();
	});

	it("splits on operators, drops redirections and keeps quoted words whole", () => {
		expect(splitShellCommandLine(`echo "a && b" > out.txt 2>&1 && cat <in | wc -l &> /dev/null; ls`)).toEqual([
			["echo", "a && b"],
			["cat"],
			["wc", "-l"],
			["ls"],
		]);
		expect(listShellCommands("env FOO=1 nohup git -C ../x push")).toEqual([["git", "push"]]);
		// A comment is not a command.
		expect(denied("ls # git push")).toBeNull();
	});

	it("tells an agent that plan approval is the user's on the board", () => {
		const planRules = parseDeniedCommandPatterns(PLAN_APPROVAL_DENY_COMMANDS, []);
		const match = findDeniedCommand("cd /repo && kanban plan approve 1a2b3", planRules);
		expect(match && describeDeniedCommand(match)).toContain(
			"Agents never approve a plan; the user approves it on the board (Approve plan).",
		);
		expect(match && describeDeniedCommand(match)).not.toContain("leave that to the orchestrator");
	});
});
