#!/usr/bin/env bash

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

strip_quotes() {
  local value="$1"
  if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
    value="${value:1:${#value}-2}"
    local escaped_single_quote="\\\\'"
    local single_quote="'"
    value="${value//$escaped_single_quote/$single_quote}"
  fi
  printf '%s' "$value"
}

env_value_from_file() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  local line
  line="$(grep -E "^(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  line="${line#export }"
  local value="${line#*=}"
  strip_quotes "$value"
}

resolve_abs_path() {
  local p="$1"
  python3 - "$p" <<'PY'
import os
import sys

path = sys.argv[1]
# Resolve existing symlink components so backup and restore operate on the same
# physical tree instead of replacing a symlinked storage root with a directory.
print(os.path.realpath(os.path.abspath(os.path.expanduser(path))))
PY
}

validate_migration_layout() {
  local config_dir="$1"
  local workspace_dir="$2"
  local auth_profile_secret_dir="$3"
  local env_file="$4"
  local restore_dir

  for restore_dir in "$config_dir" "$workspace_dir" "$auth_profile_secret_dir"; do
    [[ "$restore_dir" != "/" ]] || fail "Migration directories must not be the filesystem root"
  done
  if [[ "$config_dir" == "$workspace_dir" || "$config_dir" == "$workspace_dir"/* ]]; then
    fail "Config and workspace directories have an unsupported overlap: $config_dir and $workspace_dir"
  fi
  if [[
    "$auth_profile_secret_dir" == "$config_dir" ||
    "$auth_profile_secret_dir" == "$config_dir"/* ||
    "$config_dir" == "$auth_profile_secret_dir"/* ||
    "$auth_profile_secret_dir" == "$workspace_dir" ||
    "$auth_profile_secret_dir" == "$workspace_dir"/* ||
    "$workspace_dir" == "$auth_profile_secret_dir"/*
  ]]; then
    fail "Auth-profile secret directory must not overlap config or workspace directories"
  fi
  for restore_dir in "$config_dir" "$workspace_dir" "$auth_profile_secret_dir"; do
    if [[ "$env_file" == "$restore_dir" || "$env_file" == "$restore_dir"/* ]]; then
      fail "Env file must be outside migrated directories: $env_file"
    fi
  done
}

# Let Compose own .env interpolation, COMPOSE_FILE ordering, and default overlays.
migration_compose() {
  (
    cd "$REPO_ROOT"
    local -a options=(--project-directory "$REPO_ROOT")
    if [[ -f "$ENV_FILE" ]]; then
      options+=(--env-file "$ENV_FILE")
    fi
    docker compose "${options[@]}" "$@"
  )
}

validate_host_migration_mounts() {
  python3 -c '
import json
import sys

storage = json.load(sys.stdin)
if isinstance(storage, dict):
    gateway = storage["services"]["openclaw-gateway"]
    mounts = gateway.get("volumes", []) + [
        {"type": "tmpfs", "target": target.split(":", 1)[0]}
        for target in gateway.get("tmpfs", [])
    ]
else:
    mounts = storage
for mount in mounts:
    target = mount.get("target", mount.get("Destination", "")).rstrip("/")
    kind = mount.get("type", mount.get("Type"))
    if kind not in {"volume", "tmpfs"}:
        continue
    if any(target == root or target.startswith(root + "/") for root in (
        "/home/node/.openclaw", "/home/node/.config/openclaw"
    )):
        raise SystemExit(
            "ERROR: Docker-managed storage at " + target +
            " is not captured or restored by host migration helpers. "
            "Use openclaw backup create --verify through the full Compose file set; "
            "restore to staging and activate into the actual volumes offline."
        )
'
}

validate_host_migration_storage() {
  local selected_files="${COMPOSE_FILE:-}"
  local compose_env_file="$ENV_FILE"
  local directory="$REPO_ROOT"
  local compose_name
  if [[ ! -f "$compose_env_file" ]]; then
    compose_env_file="$REPO_ROOT/.env"
    selected_files="${selected_files:-${COMPOSE_ENV_FILES:-}}"
  fi
  # Detect possible inputs only; Compose owns env syntax, values, and precedence.
  if [[ -f "$compose_env_file" ]] && grep -Eq 'COMPOSE_(FILE|ENV_FILES)' "$compose_env_file"; then
    selected_files=env
  fi
  # Preserve offline host copies only when Compose has no selected/discoverable input.
  while [[ -z "$selected_files" ]]; do
    for compose_name in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
      if [[ -f "$directory/$compose_name" ]]; then
        selected_files="$directory/$compose_name"
        break
      fi
    done
    [[ -n "$selected_files" || "$directory" == / ]] && break
    directory="$(dirname "$directory")"
  done
  [[ -n "$selected_files" ]] || return 0
  require_cmd docker
  if ! migration_compose config --format json | validate_host_migration_mounts; then
    fail "Cannot safely migrate host directories with the selected Compose storage."
  fi
}
