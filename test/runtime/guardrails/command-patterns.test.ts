import { describe, expect, it } from "vitest";

import { DEFAULT_GUARDRAIL_DENY_COMMANDS } from "../../../src/config/pipeline-config";
import {
	expandDeniedCommandRule,
	findDeniedCommand,
	listShellCommands,
	parseDeniedCommandPatterns,
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
		expect(denied("git update-ref -d refs/heads/main")).toBe("git update-ref -d {shared}");
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
});
