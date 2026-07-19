#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/migrate/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/migrate/restore-openclaw.sh --archive <path> [options]

Options:
  --archive <path>         Backup archive created by backup-openclaw.sh (required)
  --repo-root <path>       OpenClaw repo root (default: current repo)
  --env-file <path>        Env file path (default: <repo-root>/.env)
  --config-dir <path>      OpenClaw config dir (default: env or ~/.openclaw)
  --workspace-dir <path>   OpenClaw workspace dir (default: env or ~/.openclaw/workspace)
  --auth-profile-secret-dir <path>
                           Auth-profile secret dir (default: env or ~/.openclaw-auth-profile-secrets)
  --apply-env              Overwrite --env-file with backup .env (default: false)
  --no-stop                Do not stop gateway container before restore
  -h, --help               Show this help
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$ROOT_DIR"
ENV_FILE=""
ARCHIVE_PATH=""
CONFIG_DIR=""
WORKSPACE_DIR=""
AUTH_PROFILE_SECRET_DIR=""
APPLY_ENV=0
STOP_FIRST=1
ENV_FILE_EXPLICIT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE_PATH="$2"
      shift 2
      ;;
    --repo-root)
      REPO_ROOT="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      ENV_FILE_EXPLICIT=1
      shift 2
      ;;
    --config-dir)
      CONFIG_DIR="$2"
      shift 2
      ;;
    --workspace-dir)
      WORKSPACE_DIR="$2"
      shift 2
      ;;
    --auth-profile-secret-dir)
      AUTH_PROFILE_SECRET_DIR="$2"
      shift 2
      ;;
    --apply-env)
      APPLY_ENV=1
      shift
      ;;
    --no-stop)
      STOP_FIRST=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$ARCHIVE_PATH" ]] || fail "--archive is required"

require_cmd tar
require_cmd rsync
require_cmd shasum
require_cmd python3
require_cmd date
require_cmd uname

ARCHIVE_PATH="$(resolve_abs_path "$ARCHIVE_PATH")"
REPO_ROOT="$(resolve_abs_path "$REPO_ROOT")"
if [[ $ENV_FILE_EXPLICIT -eq 0 ]]; then
  ENV_FILE="$REPO_ROOT/.env"
fi
ENV_FILE="$(resolve_abs_path "$ENV_FILE")"

[[ -f "$ARCHIVE_PATH" ]] || fail "Archive not found: $ARCHIVE_PATH"
[[ -d "$REPO_ROOT" ]] || fail "Repo root does not exist: $REPO_ROOT"
[[ -f "${ARCHIVE_PATH}.sha256" ]] || fail "Archive checksum file not found: ${ARCHIVE_PATH}.sha256"

umask 077
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

archive_checksum="$(awk 'NR == 1 { print $1 }' "${ARCHIVE_PATH}.sha256")"
[[ -n "$archive_checksum" ]] || fail "Archive checksum file is invalid: ${ARCHIVE_PATH}.sha256"
printf '%s  %s\n' "$archive_checksum" "$ARCHIVE_PATH" | shasum -a 256 -c -

echo "==> Extracting archive"
tar -xzf "$ARCHIVE_PATH" -C "$tmpdir"

[[ -f "$tmpdir/SHA256SUMS" ]] || fail "Archive missing SHA256SUMS"
(
  cd "$tmpdir"
  shasum -a 256 -c SHA256SUMS
)

if [[ -z "$CONFIG_DIR" ]]; then
  CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-$(env_value_from_file "$ENV_FILE" OPENCLAW_CONFIG_DIR)}"
fi
if [[ -z "$WORKSPACE_DIR" ]]; then
  WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$(env_value_from_file "$ENV_FILE" OPENCLAW_WORKSPACE_DIR)}"
fi
if [[ -z "$AUTH_PROFILE_SECRET_DIR" ]]; then
  AUTH_PROFILE_SECRET_DIR="${OPENCLAW_AUTH_PROFILE_SECRET_DIR:-$(env_value_from_file "$ENV_FILE" OPENCLAW_AUTH_PROFILE_SECRET_DIR)}"
fi

CONFIG_DIR="${CONFIG_DIR:-$HOME/.openclaw}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
AUTH_PROFILE_SECRET_DIR="${AUTH_PROFILE_SECRET_DIR:-$HOME/.openclaw-auth-profile-secrets}"
CONFIG_DIR="$(resolve_abs_path "$CONFIG_DIR")"
WORKSPACE_DIR="$(resolve_abs_path "$WORKSPACE_DIR")"
AUTH_PROFILE_SECRET_DIR="$(resolve_abs_path "$AUTH_PROFILE_SECRET_DIR")"

source_arch="$(grep -E '^source_arch=' "$tmpdir/meta/backup.env" | cut -d= -f2- || true)"
target_arch="$(uname -m)"
if [[ "$(uname -s)" == "Darwin" ]] && command -v sysctl >/dev/null 2>&1; then
  # Rosetta reports the process architecture, but restored native plugin state
  # must match the Apple Silicon hardware that will run Docker.
  if [[ "$(sysctl -in hw.optional.arm64 2>/dev/null || true)" == "1" ]]; then
    target_arch="arm64"
  fi
fi
arch_mismatch=0
if [[ -n "$source_arch" && "$source_arch" != "$target_arch" ]]; then
  arch_mismatch=1
fi

if [[ $STOP_FIRST -eq 1 ]] && command -v docker >/dev/null 2>&1; then
  compose_file="$REPO_ROOT/docker-compose.yml"
  [[ -f "$compose_file" ]] || fail "Compose file not found at $compose_file (use --no-stop to skip stopping the gateway)."
  echo "==> Stopping gateway container"
  if ! docker compose -f "$compose_file" stop openclaw-gateway >/dev/null 2>&1; then
    fail "Failed to stop openclaw-gateway. Fix Docker/Compose first or rerun with --no-stop if the gateway is already stopped."
  fi
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$(dirname "$CONFIG_DIR")" "$(dirname "$WORKSPACE_DIR")" "$(dirname "$AUTH_PROFILE_SECRET_DIR")"

if [[ -d "$CONFIG_DIR" ]]; then
  mv "$CONFIG_DIR" "${CONFIG_DIR}.pre-restore-${timestamp}"
fi
if [[ -d "$WORKSPACE_DIR" ]]; then
  mv "$WORKSPACE_DIR" "${WORKSPACE_DIR}.pre-restore-${timestamp}"
fi
if [[ -d "$AUTH_PROFILE_SECRET_DIR" && -d "$tmpdir/payload/auth-profile-secrets" ]]; then
  mv "$AUTH_PROFILE_SECRET_DIR" "${AUTH_PROFILE_SECRET_DIR}.pre-restore-${timestamp}"
fi

mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR" "$AUTH_PROFILE_SECRET_DIR"

echo "==> Restoring config"
config_rsync_args=(-a)
workspace_rsync_args=(-a)
plugin_payload_backup=""
if [[ $arch_mismatch -eq 1 ]]; then
  # The destination trees were moved above, so these exclusions cannot leave
  # stale source-architecture plugin roots active after the restore.
  config_rsync_args+=(--exclude=/extensions/ --exclude=/git/ --exclude=/npm/)
  workspace_rsync_args+=(--exclude=/.openclaw/extensions/)

  source_arch_label="${source_arch//[^A-Za-z0-9._-]/_}"
  plugin_payload_backup="${CONFIG_DIR}.source-arch-plugin-state-${source_arch_label}-${timestamp}"
  mkdir -p "$plugin_payload_backup/config" "$plugin_payload_backup/workspace/.openclaw"
  for relative_dir in extensions git npm; do
    if [[ -d "$tmpdir/payload/config/$relative_dir" ]]; then
      rsync -a \
        "$tmpdir/payload/config/$relative_dir/" \
        "$plugin_payload_backup/config/$relative_dir/"
    fi
  done
  if [[ -d "$tmpdir/payload/workspace/.openclaw/extensions" ]]; then
    rsync -a \
      "$tmpdir/payload/workspace/.openclaw/extensions/" \
      "$plugin_payload_backup/workspace/.openclaw/extensions/"
  fi
fi
rsync "${config_rsync_args[@]}" "$tmpdir/payload/config/" "$CONFIG_DIR/"

echo "==> Restoring workspace"
rsync "${workspace_rsync_args[@]}" "$tmpdir/payload/workspace/" "$WORKSPACE_DIR/"

if [[ -d "$tmpdir/payload/auth-profile-secrets" ]]; then
  echo "==> Restoring auth-profile secret directory"
  rsync -a "$tmpdir/payload/auth-profile-secrets/" "$AUTH_PROFILE_SECRET_DIR/"
fi

write_restored_env() {
  local source_file="$1"
  local destination_file="$2"
  python3 - \
    "$source_file" \
    "$destination_file" \
    "$CONFIG_DIR" \
    "$WORKSPACE_DIR" \
    "$AUTH_PROFILE_SECRET_DIR" <<'PY'
import os
import re
import sys
import tempfile

source_path, destination_path, config_dir, workspace_dir, auth_dir = sys.argv[1:]
replacements = {
    "OPENCLAW_CONFIG_DIR": config_dir,
    "OPENCLAW_WORKSPACE_DIR": workspace_dir,
    "OPENCLAW_AUTH_PROFILE_SECRET_DIR": auth_dir,
}
assignment = re.compile(r"^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=")
seen = set()
output = []


def dotenv_literal(value):
    return "'" + value.replace("'", "\\'") + "'"

with open(source_path, encoding="utf-8") as source:
    for raw_line in source.read().splitlines():
        match = assignment.match(raw_line)
        if match and match.group(2) in replacements:
            key = match.group(2)
            output.append(f"{match.group(1)}{key}={dotenv_literal(replacements[key])}")
            seen.add(key)
        else:
            output.append(raw_line)

for key, value in replacements.items():
    if key not in seen:
        output.append(f"{key}={dotenv_literal(value)}")

destination_dir = os.path.dirname(destination_path) or "."
fd, temporary_path = tempfile.mkstemp(
    dir=destination_dir,
    prefix=f".{os.path.basename(destination_path)}.",
)
try:
    os.fchmod(fd, 0o600)
    destination = os.fdopen(fd, "w", encoding="utf-8")
    fd = None
    with destination:
        destination.write("\n".join(output) + "\n")
    os.replace(temporary_path, destination_path)
except BaseException:
    if fd is not None:
        os.close(fd)
    try:
        os.unlink(temporary_path)
    except FileNotFoundError:
        pass
    raise
PY
}

if [[ -f "$tmpdir/payload/repo/.env" ]]; then
  if [[ $APPLY_ENV -eq 1 ]]; then
    mkdir -p "$(dirname "$ENV_FILE")"
    if [[ -f "$ENV_FILE" ]]; then
      cp "$ENV_FILE" "${ENV_FILE}.pre-restore-${timestamp}"
      chmod 600 "${ENV_FILE}.pre-restore-${timestamp}"
    fi
    write_restored_env "$tmpdir/payload/repo/.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "==> Applied backed up env file to $ENV_FILE"
  else
    mkdir -p "$(dirname "$ENV_FILE")"
    write_restored_env "$tmpdir/payload/repo/.env" "${ENV_FILE}.from-backup"
    chmod 600 "${ENV_FILE}.from-backup"
    echo "==> Wrote env candidate to ${ENV_FILE}.from-backup"
  fi
fi

if [[ $arch_mismatch -eq 1 ]]; then
  echo
  echo "NOTE: source arch (${source_arch}) differs from target arch (${target_arch})."
  echo "Architecture-specific plugin state was not activated on this host."
  echo "Preserved source plugin state: $plugin_payload_backup"
  echo "Rebuild the image, reinstall tracked plugins, and rebuild local plugin dependencies."
fi

echo
echo "Restore completed."
echo "Next steps:"
if [[ -f "$tmpdir/payload/repo/.env" && $APPLY_ENV -eq 0 ]]; then
  echo "  1) Review ${ENV_FILE}.from-backup and install the intended values in $ENV_FILE."
else
  echo "  1) Review the restored Docker environment values in $ENV_FILE."
fi
echo "  2) Export the restored OPENCLAW_* values required by Docker setup."
echo "  3) cd \"$REPO_ROOT\" && ./scripts/docker/setup.sh"
echo "     Setup regenerates required extra/sandbox Compose overlays before startup."
echo "  4) Use the full 'docker compose -f ...' command printed by setup for all commands below."
if [[ $arch_mismatch -eq 1 ]]; then
  echo "  5) <full-compose-command> run --rm openclaw-cli plugins update --all"
  echo "  6) <full-compose-command> run --rm openclaw-cli doctor --fix"
  echo "  7) Reinstall/rebuild any local or path plugins preserved under: $plugin_payload_backup"
  echo "  8) <full-compose-command> restart openclaw-gateway"
  echo "  9) <full-compose-command> run --rm openclaw-cli health"
  echo " 10) <full-compose-command> run --rm openclaw-cli channels status --probe"
else
  echo "  5) <full-compose-command> run --rm openclaw-cli health"
  echo "  6) <full-compose-command> run --rm openclaw-cli channels status --probe"
fi
