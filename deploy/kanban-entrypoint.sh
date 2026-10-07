#!/bin/sh
# Entrypoint of the kanban-dev image (deploy/Containerfile; docs/fork/container-lifecycle.md). Runs the container
# command ("$@": the image CMD `kanban --port 3485 ...`, or a quadlet Exec= / `podman run` override) as a CHILD,
# so a container stop can do work before Kanban gets the signal:
#  - at start, launches the start hook detached (never waited for): $KANBAN_START_HOOK, else `<kit>/bin/kit boot`
#    when that is executable (waits for Kanban, then starts the kit services).
#  - on SIGTERM/SIGINT, runs the pre-stop hook for at most $KANBAN_PRESTOP_TIMEOUT s (default 45):
#    $KANBAN_PRESTOP_HOOK, else `<kit>/bin/kit prepare-restart` when executable (tags the WIP of running cards and
#    writes the restart manifest). Then forwards the signal to the child and waits for it. A failing, missing or
#    hung hook never blocks the stop; a second signal cuts the hook short (or, after it, is forwarded at once).
#  - exits with the child's exit status (128+N when a signal killed it).
# Hooks are `sh -c` strings; set one to the empty string to turn it off. <kit> is $KANBAN_KIT_HOME, default
# /root/.kanban (the persistent volume). Hook output goes to <kit>/logs/kanban-entrypoint.log when that dir is
# writable, else stderr; the step lines go to stderr (podman logs) and that log.
# Replaces node's docker-entrypoint.sh, which only prefixes `node` when the command is a flag or not on PATH.
set -u

kit_home=${KANBAN_KIT_HOME:-/root/.kanban}
prestop_timeout=${KANBAN_PRESTOP_TIMEOUT:-45}
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

# run_prestop: the pre-stop hook in its own process group (timeout's), killed with it at the deadline or on a
# second stop signal. Returns once the hook is over or abandoned.
run_prestop() {
	if [ -z "$prestop_hook" ]; then
		log "no pre-stop hook"
		return 0
	fi
	if ! command -v timeout >/dev/null 2>&1; then
		log "pre-stop hook skipped: no timeout command to bound it"
		return 0
	fi
	log "pre-stop hook (timeout ${prestop_timeout}s): $prestop_hook"
	if [ -n "$hook_log" ]; then
		timeout -k 5 "$prestop_timeout" sh -c "$prestop_hook" </dev/null >>"$hook_log" 2>&1 &
	else
		timeout -k 5 "$prestop_timeout" sh -c "$prestop_hook" </dev/null >&2 &
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
			log "SIG$pending again: abandoning the pre-stop hook"
			pending=
			kill -TERM "$hook_pid" 2>/dev/null
			return 0
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
	0) log "pre-stop hook done" ;;
	124 | 137) log "pre-stop hook timed out after ${prestop_timeout}s" ;;
	*) log "pre-stop hook failed (exit $hook_status)" ;;
	esac
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
