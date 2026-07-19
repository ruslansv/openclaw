#!/usr/bin/env bash
set -euo pipefail

RUNTIME_PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"
# Privileged startup must not resolve commands from directories writable by node.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

if [ "$(id -u)" -ne 0 ]; then
  echo "gateway-entrypoint requires root (set docker compose service user: root)" >&2
  exit 1
fi

if [ "${OPENCLAW_ENABLE_CRON:-1}" = "1" ] && command -v cron >/dev/null 2>&1; then
  # Start cron daemon once; jobs are configured by user crontabs via `crontab`.
  if ! pgrep -x cron >/dev/null 2>&1; then
    cron
  fi
fi

ensure_node_writable_dir() {
  local dir="$1"
  mkdir -p "$dir"
  chown -R node:node "$dir"
}

export COREPACK_HOME="${COREPACK_HOME:-/home/node/.cache/node/corepack}"
ensure_node_writable_dir /home/node/.cache
ensure_node_writable_dir /home/node/.npm
ensure_node_writable_dir "${PNPM_HOME:-/home/node/.local/share/pnpm}"
ensure_node_writable_dir "${NPM_CONFIG_PREFIX:-/home/node/.npm-global}"
ensure_node_writable_dir "${GOPATH:-/home/node/go}"

if gosu_path="$(command -v gosu 2>/dev/null)"; then
  exec env PATH="$RUNTIME_PATH" "$gosu_path" node "$@"
fi

# Preserve argument boundaries when gosu is unavailable.
exec env PATH="$RUNTIME_PATH" /usr/bin/su -s /bin/sh node -c 'exec "$0" "$@"' "$@"
