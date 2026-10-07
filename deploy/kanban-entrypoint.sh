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
