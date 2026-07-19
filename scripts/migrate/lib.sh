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
