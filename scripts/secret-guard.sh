#!/usr/bin/env bash
# secret-guard: blocks a git push when the commits being pushed ADD a secret, and scans existing history on
# request. Ported from archive/devteam-kit:scripts/secret-guard.sh@00325b6 (was forks/secret-guard.sh).
#
# It checks the added lines and the commit message of every commit for two things:
#  1. well-known key shapes (Bedrock ABSK..., AWS AKIA.../ASIA..., sk-... at a token start, so
#     "task-agent-settings-fields" is not a hit; ghp_/gho_/ghs_/github_pat_..., private key blocks);
#  2. the EXACT secret values used on this machine, read at run time from the files that hold them
#     (Claude settings, Cline providers.json, Codex config.toml, $KANBAN_HOME/data/*/*.env), plus the GitHub PAT in
#     $GH_TOKEN / $GITHUB_TOKEN and the Bedrock key in $AWS_BEARER_TOKEN_BEDROCK when set (docs/fork/github-auth.md).
# It never prints a secret, only the commit, the kind of hit and the files.
#
# Usage:
#   scripts/secret-guard.sh <remote> [<url>]       pre-push hook mode: reads "<lref> <lsha> <rref> <rsha>" on stdin
#                                                   and scans the commits not yet on <remote>
#   scripts/secret-guard.sh --scan <rev-list args>  scan every commit git rev-list selects, e.g.
#                                                   scripts/secret-guard.sh --scan archive/devteam-kit
# Tested by test/integration/secret-guard.integration.test.ts (npm run test).
# Wiring it in (not done by the repo config): add a .husky/pre-push containing
#   exec scripts/secret-guard.sh "$@"
# Bypass deliberately: SECRET_GUARD=off git push ...
[ "${SECRET_GUARD:-on}" = "off" ] && exit 0
H="${HOME:-/root}"
KH="${KANBAN_HOME:-$H/.kanban}"
known=()
while IFS= read -r v; do [ ${#v} -ge 16 ] && known+=("$v"); done < <(
	{
		node -e '
			const fs=require("fs"),H=process.argv[1],out=new Set();
			const walk=(o)=>{if(!o||typeof o!=="object")return;for(const [k,v] of Object.entries(o)){if(typeof v==="string"&&/key|token|secret|password|bearer/i.test(k))out.add(v);else walk(v)}};
			for(const f of [H+"/.claude/settings.json",H+"/.cline/data/settings/providers.json"]){try{walk(JSON.parse(fs.readFileSync(f,"utf8")))}catch{}}
			console.log([...out].join("\n"))' "$H"
		grep -hoE '(bearer_token|api_key|token|key)[[:space:]]*=[[:space:]]*"[^"]+"' "$H/.codex/config.toml" 2>/dev/null |
			sed -E 's/^[^"]*"([^"]+)".*/\1/'
		grep -hoE '^[A-Z_]*(KEY|TOKEN|SECRET)[A-Z_]*=.+' "$KH"/data/*/*.env 2>/dev/null | sed -E 's/^[^=]+=//'
		printf '%s\n' "${GH_TOKEN:-}" "${GITHUB_TOKEN:-}" "${AWS_BEARER_TOKEN_BEDROCK:-}"
	} | sort -u
)
pattern='ABSK[A-Za-z0-9+/=]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|(^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}|gh[pos]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'
z=0000000000000000000000000000000000000000
bad=0

empty_tree=$(git hash-object -t tree /dev/null)

# base_of <sha>: what a commit's additions are measured against: its first parent (so a merge, evil or not,
# reports everything it brings onto the branch), or the empty tree for a root commit.
base_of() { git rev-parse -q --verify "$1^1" 2>/dev/null || echo "$empty_tree"; }

# added_lines <sha>: the content of every line the commit adds. A plain two-tree diff, so each added line has
# exactly one leading "+"; file headers ("+++ b/...") are skipped by position (before a file's first hunk),
# not by shape, so an added line that itself starts with "++" is kept.
added_lines() {
	git diff --no-color --no-ext-diff --no-textconv --unified=0 "$(base_of "$1")" "$1" |
		awk '/^diff --git /{h=1; next} /^@@/{h=0; next} !h && /^\+/{print substr($0, 2)}'
}

# check_commit <sha> <label>: report a commit whose added lines or message hold a secret.
check_commit() {
	local c=$1 label=$2 text hit="" v files
	text="$(git log -1 --format=%B "$c")
$(added_lines "$c")"
	printf '%s' "$text" | grep -qE "$pattern" && hit="key-shaped string"
	for v in "${known[@]}"; do case "$text" in *"$v"*) hit="a secret value used on this machine" ;; esac; done
	[ -z "$hit" ] && return 0
	files=$(git diff --name-only "$(base_of "$c")" "$c" | tr '\n' ' ')
	echo "secret-guard: $label: commit ${c:0:10} adds $hit (files: ${files:-none})" >&2
	bad=1
}

if [ "$1" = "--scan" ]; then
	shift
	[ $# -gt 0 ] || { echo "usage: $0 --scan <rev-list args>" >&2; exit 2; }
	echo "secret-guard: ${#known[@]} known secret values loaded" >&2
	n=0
	for c in $(git rev-list "$@"); do check_commit "$c" "FOUND"; n=$((n + 1)); done
	[ $bad = 0 ] && echo "secret-guard: $n commits scanned, clean" >&2
	exit $bad
fi

remote=${1:-origin}
while read -r lref lsha _rref rsha; do
	[ "$lsha" = "$z" ] && continue
	# Commits not on any ref of this remote yet (and not on the ref being replaced, when we have it).
	excl=(--not --remotes="$remote")
	[ "$rsha" != "$z" ] && git cat-file -e "$rsha^{commit}" 2>/dev/null && excl+=("$rsha")
	for c in $(git rev-list "$lsha" "${excl[@]}"); do check_commit "$c" "BLOCKED push of ${lref#refs/heads/}"; done
done
[ $bad = 0 ] || { echo "secret-guard: remove it from the commit (git rebase -i / amend) and push again." >&2; exit 1; }
