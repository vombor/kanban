#!/bin/sh
# Entrypoint of the kanban-dev image (deploy/Containerfile; docs/fork/container-lifecycle.md). Runs the container
# command ("$@": the image CMD `kanban --port 3485 ...`, or a quadlet Exec= / `podman run` override) as a CHILD,
# so a container stop can do work before Kanban gets the signal:
#  - at start, launches the start hook detached (never waited for): $KANBAN_START_HOOK, else `<kit>/bin/kit boot`
#    when that is executable (waits for Kanban, then starts the kit services).
#  - on SIGTERM/SIGINT, runs the pre-stop hook for at most $KANBAN_PRESTOP_TIMEOUT s (default 45):
#    $KANBAN_PRESTOP_HOOK, else `<kit>/bin/kit prepare-restart` when executable (tags the WIP of running cards and
#    writes the restart manifest), then the runtime's restart prepare for at most $KANBAN_RESTART_PREPARE_TIMEOUT s
#    (default 20): $KANBAN_RESTART_PREPARE_HOOK, else `kanban restart prepare` when `kanban` is on PATH (the
#    runtime's WIP tags and restart manifest for every workspace, with the server's start time). Both run while
#    Kanban is still up; 45 + 20 s plus Kanban's own 10 s fit the quadlet's StopTimeout=90. Then forwards the
#    signal to the child and waits for it. A failing, missing or hung step never blocks the stop (each logs one
#    result line); a second signal cuts the running step short and skips the rest (or, after them, is forwarded
#    at once).
#  - exits with the child's exit status (128+N when a signal killed it).
# Hooks are `sh -c` strings; set one to the empty string to turn it off. <kit> is $KANBAN_KIT_HOME, default
# /root/.kanban (the persistent volume). Hook output goes to <kit>/logs/kanban-entrypoint.log when that dir is
# writable, else stderr; the step lines go to stderr (podman logs) and that log. The restart prepare step gets the
# command's --port/--host/--home/--https as KANBAN_RUNTIME_PORT/KANBAN_RUNTIME_HOST/KANBAN_HOME/KANBAN_RUNTIME_HTTPS:
# a CLI started from here would otherwise look for the server on the default port (3484, the image uses 3485).
# GitHub PAT: with GH_TOKEN set (gh reads it natively; GITHUB_TOKEN is accepted as a fallback), the user's .npmrc
# ($NPM_CONFIG_USERCONFIG, else $HOME/.npmrc, on the /root volume) gets `@vombor:registry=https://npm.pkg.github.com`
# and `//npm.pkg.github.com/:_authToken=${GH_TOKEN}`, so npm can install the fork's package from GitHub Packages. The
# file holds only that reference (npm expands it at read time), never the token. Lines the user set for either key
# stay as they are. It also runs `gh auth setup-git`, which sets gh as git's credential helper for github.com in the
# global git config (on /root), so https clones, fetches and pushes use the PAT; remote URLs are never changed.
# Nothing changes when no token variable is set (gh then uses /root/.config/gh). See docs/fork/github-auth.md.
# Replaces node's docker-entrypoint.sh, which only prefixes `node` when the command is a flag or not on PATH.
set -u

kit_home=${KANBAN_KIT_HOME:-/root/.kanban}
prestop_timeout=${KANBAN_PRESTOP_TIMEOUT:-45}
restart_prepare_timeout=${KANBAN_RESTART_PREPARE_TIMEOUT:-20}
hook_log=
if [ -d "$kit_home/logs" ] && [ -w "$kit_home/logs" ]; then
	hook_log=$kit_home/logs/kanban-entrypoint.log
fi

log() {
	line="$(date -u +%Y-%m-%dT%H:%M:%SZ) kanban-entrypoint: $*"
	printf '%s\n' "$line" >&2
	if [ -n "$hook_log" ]; then
		printf '%s\n' "$line" >>"$hook_log" 2>/dev/null
	fi
	return 0
}

# setup_npm_github_auth: the .npmrc lines described above. Never expands the token itself (only ${VAR:+set}), so even
# `set -x` doesn't print it. Idempotent: an auth line that is one of our references is rewritten to the current one,
# any other line for those keys is the user's and kept; the file is rewritten in place only when it changes.
setup_npm_github_auth() {
	if [ -n "${GH_TOKEN:+set}" ]; then
		token_var=GH_TOKEN
	elif [ -n "${GITHUB_TOKEN:+set}" ]; then
		token_var=GITHUB_TOKEN
	else
		return 0
	fi
	npmrc=${NPM_CONFIG_USERCONFIG:-${npm_config_userconfig:-${HOME:-/root}/.npmrc}}
	npmrc_tmp="$npmrc.kanban-entrypoint.$$"
	if ! (umask 077 && { [ -f "$npmrc" ] || : >"$npmrc"; } && : >"$npmrc_tmp") 2>/dev/null; then
		log "npm auth for @vombor: cannot write $npmrc"
		return 0
	fi
	# shellcheck disable=SC2016 # the ${...} references are the literal text npm expands.
	if ! awk -v ref="\${$token_var}" '
		function trim(text) { sub(/^[ \t]+/, "", text); sub(/[ \t\r]+$/, "", text); return text }
		{
			eq = index($0, "=")
			key = eq ? trim(substr($0, 1, eq - 1)) : ""
			value = eq ? trim(substr($0, eq + 1)) : ""
			if (key == "@vombor:registry") has_scope = 1
			if (key == "//npm.pkg.github.com/:_authToken") {
				has_auth = 1
				if (value == "${GH_TOKEN}" || value == "${GITHUB_TOKEN}") {
					print key "=" ref
					next
				}
			}
			print
		}
		END {
			if (!has_scope) print "@vombor:registry=https://npm.pkg.github.com"
			if (!has_auth) print "//npm.pkg.github.com/:_authToken=" ref
		}
	' "$npmrc" >"$npmrc_tmp"; then
		# A partial temp file must never replace the user's .npmrc.
		log "npm auth for @vombor: could not read $npmrc (awk failed), left it unchanged"
		rm -f "$npmrc_tmp"
		return 0
	fi
	if cmp -s "$npmrc" "$npmrc_tmp"; then
		log "npm auth for @vombor: $npmrc already set"
	elif cat "$npmrc_tmp" >"$npmrc"; then
		log "npm auth for @vombor: $npmrc references \$$token_var"
	else
		log "npm auth for @vombor: cannot write $npmrc"
	fi
	rm -f "$npmrc_tmp"
	return 0
}

# setup_git_github_auth: gh as git's credential helper for https://github.com (gh reads GH_TOKEN/GITHUB_TOKEN itself).
# `gh auth setup-git` replaces its own helper lines, so a restart doesn't add more.
setup_git_github_auth() {
	[ -n "${GH_TOKEN:+set}${GITHUB_TOKEN:+set}" ] || return 0
	if ! command -v gh >/dev/null 2>&1; then
		log "git auth for github.com: no gh on PATH"
		return 0
	fi
	if gh auth setup-git --hostname github.com </dev/null >/dev/null 2>&1; then
		log "git auth for github.com: gh credential helper set"
	else
		log "git auth for github.com: gh auth setup-git failed"
	fi
	return 0
}

kit=$kit_home/bin/kit
if [ -n "${KANBAN_START_HOOK+set}" ]; then
	start_hook=$KANBAN_START_HOOK
elif [ -x "$kit" ]; then
	start_hook="'$kit' boot"
else
	start_hook=
fi
if [ -n "${KANBAN_PRESTOP_HOOK+set}" ]; then
	prestop_hook=$KANBAN_PRESTOP_HOOK
elif [ -x "$kit" ]; then
	prestop_hook="'$kit' prepare-restart"
else
	prestop_hook=
fi

if [ -n "${KANBAN_RESTART_PREPARE_HOOK+set}" ]; then
	restart_prepare_hook=$KANBAN_RESTART_PREPARE_HOOK
elif command -v kanban >/dev/null 2>&1; then
	restart_prepare_hook="kanban restart prepare"
else
	restart_prepare_hook=
fi

# Where the command's server listens, for the restart prepare step. Empty: the CLI's own env/defaults (a command the
# entrypoint can't read, like `sh -c '... exec kanban ...'`, or `--port auto`; set KANBAN_RUNTIME_PORT etc. then).
runtime_port=
runtime_host=
runtime_home=
runtime_https=
option=
for arg in "$@"; do
	case $option in
	--port) runtime_port=$arg ;;
	--host) runtime_host=$arg ;;
	--home) runtime_home=$arg ;;
	esac
	option=
	case $arg in
	--port | --host | --home) option=$arg ;;
	--port=*) runtime_port=${arg#--port=} ;;
	--host=*) runtime_host=${arg#--host=} ;;
	--home=*) runtime_home=${arg#--home=} ;;
	--https) runtime_https=1 ;;
	esac
done
case $runtime_port in
'' | *[!0-9]*) runtime_port= ;;
esac

# The restart prepare step's environment (run in its subshell): the command's server, where the entrypoint knows it.
export_runtime_env() {
	[ -z "$runtime_port" ] || export KANBAN_RUNTIME_PORT="$runtime_port"
	[ -z "$runtime_host" ] || export KANBAN_RUNTIME_HOST="$runtime_host"
	[ -z "$runtime_home" ] || export KANBAN_HOME="$runtime_home"
	[ -z "$runtime_https" ] || export KANBAN_RUNTIME_HTTPS=1
	return 0
}

if [ "$#" -eq 0 ]; then
	log "no command given"
	exit 64
fi

setup_npm_github_auth
setup_git_github_auth

# Signals only set a flag; the main loop (or the pre-stop wait) acts on it once `wait` is interrupted.
pending=
trap 'pending=TERM' TERM
trap 'pending=INT' INT
trap 'pending=HUP' HUP

if [ -n "$start_hook" ]; then
	log "start hook (detached): $start_hook"
	# The subshell exits at once, so the hook is reparented to pid 1 (podman-init reaps it).
	if [ -n "$hook_log" ]; then
		(sh -c "$start_hook" </dev/null >>"$hook_log" 2>&1 &)
	else
		(sh -c "$start_hook" </dev/null >&2 &)
	fi
fi

# A non-interactive sh starts background jobs with SIGINT/SIGQUIT ignored; give the child the defaults back so a
# forwarded SIGINT reaches it.
if env --default-signal=INT,QUIT true 2>/dev/null; then
	env --default-signal=INT,QUIT "$@" &
else
	"$@" &
fi
child=$!
log "started pid $child: $*"

# run_stop_step <label> <hook> <timeout> [<env setup>]: one pre-stop step in its own process group (timeout's),
# killed with it at the deadline or on a second stop signal. <env setup> is a function run in the step's subshell
# first. Returns once the step is over (0) or abandoned by a second stop signal (1: skip the remaining steps).
run_stop_step() {
	label=$1
	hook=$2
	step_timeout=$3
	env_setup=${4:-:}
	if [ -z "$hook" ]; then
		log "no $label"
		return 0
	fi
	if ! command -v timeout >/dev/null 2>&1; then
		log "$label skipped: no timeout command to bound it"
		return 0
	fi
	log "$label (timeout ${step_timeout}s): $hook"
	if [ -n "$hook_log" ]; then
		("$env_setup" && exec timeout -k 5 "$step_timeout" sh -c "$hook") </dev/null >>"$hook_log" 2>&1 &
	else
		("$env_setup" && exec timeout -k 5 "$step_timeout" sh -c "$hook") </dev/null >&2 &
	fi
	hook_pid=$!
	hook_status=
	while :; do
		# A signal caught outside `wait` (its trap already ran) would not interrupt it: check first.
		if [ -z "$pending" ]; then
			wait "$hook_pid"
			hook_status=$?
		fi
		case $pending in
		TERM | INT)
			log "SIG$pending again: abandoning the $label"
			pending=
			kill -TERM "$hook_pid" 2>/dev/null
			return 1
			;;
		HUP)
			pending=
			log "forwarding SIGHUP to pid $child"
			kill -HUP "$child" 2>/dev/null
			continue
			;;
		esac
		break
	done
	case $hook_status in
	0) log "$label done" ;;
	124 | 137) log "$label timed out after ${step_timeout}s" ;;
	*) log "$label failed (exit $hook_status)" ;;
	esac
	return 0
}

# run_prestop: the kit's pre-stop hook, then the runtime's restart prepare, both before Kanban gets the signal.
run_prestop() {
	run_stop_step "pre-stop hook" "$prestop_hook" "$prestop_timeout" || return 0
	if [ -n "$restart_prepare_hook" ] && ! kill -0 "$child" 2>/dev/null; then
		log "restart prepare skipped: pid $child already exited"
		return 0
	fi
	run_stop_step "restart prepare" "$restart_prepare_hook" "$restart_prepare_timeout" export_runtime_env
	return 0
}

stopping=
status=0
while :; do
	if [ -z "$pending" ]; then
		wait "$child"
		status=$?
		[ -n "$pending" ] || break
	fi
	sig=$pending
	pending=
	if ! kill -0 "$child" 2>/dev/null; then
		# The child exited around the signal. If this wait was interrupted, the next one has its status.
		wait "$child" 2>/dev/null
		late_status=$?
		[ "$late_status" -eq 127 ] || status=$late_status
		break
	fi
	if [ "$sig" = HUP ]; then
		log "forwarding SIGHUP to pid $child"
	elif [ -z "$stopping" ]; then
		stopping=1
		log "SIG$sig: pre-stop before stopping pid $child"
		run_prestop
		log "forwarding SIG$sig to pid $child"
	else
		log "SIG$sig again: forwarding to pid $child at once"
	fi
	kill -"$sig" "$child" 2>/dev/null
done
log "pid $child exited with status $status"
exit "$status"
