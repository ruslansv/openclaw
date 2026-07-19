#!/usr/bin/env bash
set -euo pipefail

PID_FILE="${OPENCLAW_KEEPAWAKE_PID_FILE:-$HOME/.openclaw/run/keepawake.pid}"
KEEPAWAKE_FLAGS="${OPENCLAW_KEEPAWAKE_FLAGS:--imsu}"

usage() {
  cat <<'USAGE'
Usage: scripts/openclaw-keepawake.sh <on|off|status|restart>

Keeps macOS awake using `caffeinate` for long-running OpenClaw Docker sessions.

Commands:
  on       Start keep-awake background process
  off      Stop keep-awake background process
  status   Show current keep-awake status
  restart  Restart keep-awake background process

Environment:
  OPENCLAW_KEEPAWAKE_FLAGS  caffeinate flags (default: -imsu)
                            Use -dimsu to keep displays awake too.
USAGE
}

ensure_caffeinate() {
  if ! command -v caffeinate >/dev/null 2>&1; then
    echo "caffeinate not found (this helper is for macOS)." >&2
    exit 1
  fi
}

read_pid_record() {
  TRACKED_PID=""
  TRACKED_START_ID=""
  if [[ -f "$PID_FILE" ]]; then
    IFS=$'\t' read -r TRACKED_PID TRACKED_START_ID <"$PID_FILE" || true
  fi
}

is_caffeinate_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  local comm
  comm="$(ps -p "$pid" -o comm= 2>/dev/null | tr -d '[:space:]')"
  # macOS may report the executable's absolute path for `comm=`.
  comm="${comm##*/}"
  [[ "$comm" == "caffeinate" ]]
}

process_start_identity() {
  local pid="$1"
  LC_ALL=C TZ=UTC ps -p "$pid" -o lstart= 2>/dev/null |
    sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

process_elapsed_seconds() {
  local pid="$1"
  local elapsed days=0 hours=0 minutes=0 seconds=0
  elapsed="$(LC_ALL=C ps -p "$pid" -o etime= 2>/dev/null | tr -d '[:space:]')"
  [[ -n "$elapsed" ]] || return 1
  if [[ "$elapsed" == *-* ]]; then
    days="${elapsed%%-*}"
    elapsed="${elapsed#*-}"
  fi
  local -a parts
  IFS=: read -r -a parts <<<"$elapsed"
  case "${#parts[@]}" in
  2)
    minutes="${parts[0]}"
    seconds="${parts[1]}"
    ;;
  3)
    hours="${parts[0]}"
    minutes="${parts[1]}"
    seconds="${parts[2]}"
    ;;
  *) return 1 ;;
  esac
  printf '%s\n' "$((10#$days * 86400 + 10#$hours * 3600 + 10#$minutes * 60 + 10#$seconds))"
}

pid_file_mtime_epoch() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%m' "$PID_FILE" 2>/dev/null
  else
    stat -c '%Y' "$PID_FILE" 2>/dev/null
  fi
}

adopt_legacy_pid_record() {
  [[ -n "$TRACKED_PID" && -z "$TRACKED_START_ID" ]] || return 0
  is_caffeinate_pid "$TRACKED_PID" || return 0

  local elapsed file_mtime file_age delta start_id
  elapsed="$(process_elapsed_seconds "$TRACKED_PID")" || return 0
  file_mtime="$(pid_file_mtime_epoch)" || return 0
  file_age="$(($(date +%s) - file_mtime))"
  delta="$((file_age - elapsed))"
  if ((delta < 0)); then
    delta="$((-delta))"
  fi
  # The legacy helper wrote the PID immediately after launching caffeinate.
  ((delta <= 5)) || return 0

  start_id="$(process_start_identity "$TRACKED_PID")"
  [[ -n "$start_id" ]] || return 0
  TRACKED_START_ID="$start_id"
  printf '%s\t%s\n' "$TRACKED_PID" "$TRACKED_START_ID" >"$PID_FILE"
}

is_tracked_caffeinate() {
  local pid="$1"
  local expected_start_id="$2"
  [[ -n "$expected_start_id" ]] || return 1
  is_caffeinate_pid "$pid" || return 1
  [[ "$(process_start_identity "$pid")" == "$expected_start_id" ]]
}

start_awake() {
  ensure_caffeinate
  mkdir -p "$(dirname "$PID_FILE")"

  read_pid_record
  adopt_legacy_pid_record
  if is_tracked_caffeinate "$TRACKED_PID" "$TRACKED_START_ID"; then
    echo "keep-awake already on (pid $TRACKED_PID)"
    return 0
  fi
  rm -f "$PID_FILE"

  local -a flags
  local pid start_id
  # Allow override for special cases (for example keeping displays on).
  read -r -a flags <<<"$KEEPAWAKE_FLAGS"
  caffeinate "${flags[@]}" >/dev/null 2>&1 &
  pid="$!"
  sleep 0.2
  if ! is_caffeinate_pid "$pid"; then
    rm -f "$PID_FILE"
    echo "Failed to start keep-awake (caffeinate exited immediately)." >&2
    exit 1
  fi
  start_id="$(process_start_identity "$pid")"
  if [[ -z "$start_id" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
    echo "Failed to identify keep-awake process start time." >&2
    exit 1
  fi
  printf '%s\t%s\n' "$pid" "$start_id" >"$PID_FILE"
  echo "keep-awake on (pid $pid, flags: $KEEPAWAKE_FLAGS)"
}

stop_awake() {
  read_pid_record
  adopt_legacy_pid_record
  if [[ -z "$TRACKED_PID" ]]; then
    echo "keep-awake already off"
    return 0
  fi

  if is_tracked_caffeinate "$TRACKED_PID" "$TRACKED_START_ID"; then
    kill "$TRACKED_PID" >/dev/null 2>&1 || true
    echo "keep-awake off (stopped pid $TRACKED_PID)"
  else
    echo "keep-awake off (stale pid file removed)"
  fi
  rm -f "$PID_FILE"
}

status_awake() {
  read_pid_record
  adopt_legacy_pid_record
  if is_tracked_caffeinate "$TRACKED_PID" "$TRACKED_START_ID"; then
    echo "keep-awake is on (pid $TRACKED_PID)"
  else
    echo "keep-awake is off"
    if [[ -n "$TRACKED_PID" ]]; then
      rm -f "$PID_FILE"
    fi
  fi
}

cmd="${1:-}"
case "$cmd" in
on)
  start_awake
  ;;
off)
  stop_awake
  ;;
status)
  status_awake
  ;;
restart)
  stop_awake
  start_awake
  ;;
*)
  usage
  exit 2
  ;;
esac
