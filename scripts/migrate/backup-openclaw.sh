#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/migrate/lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/migrate/backup-openclaw.sh [options]

Options:
  --repo-root <path>       OpenClaw repo root (default: current repo)
  --env-file <path>        Env file to include (default: <repo-root>/.env)
  --config-dir <path>      OpenClaw config dir (default: env or ~/.openclaw)
  --workspace-dir <path>   OpenClaw workspace dir (default: env or ~/.openclaw/workspace)
  --auth-profile-secret-dir <path>
                           Auth-profile secret dir (default: env or ~/.openclaw-auth-profile-secrets)
  --output-dir <path>      Output directory for backup archive (default: <repo-root>/backups)
  --name <name>            Backup name prefix (default: openclaw-backup-<timestamp>)
  --no-stop                Do not stop/restart the gateway; only use when it is already quiesced
  -h, --help               Show this help
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$ROOT_DIR"
ENV_FILE=""
CONFIG_DIR=""
WORKSPACE_DIR=""
AUTH_PROFILE_SECRET_DIR=""
OUTPUT_DIR=""
BACKUP_NAME=""
ENV_FILE_EXPLICIT=0
OUTPUT_DIR_EXPLICIT=0
STOP_FIRST=1

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --output-dir)
      OUTPUT_DIR="$2"
      OUTPUT_DIR_EXPLICIT=1
      shift 2
      ;;
    --name)
      BACKUP_NAME="$2"
      shift 2
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

require_cmd tar
require_cmd rsync
require_cmd shasum
require_cmd python3
require_cmd date
require_cmd uname

REPO_ROOT="$(resolve_abs_path "$REPO_ROOT")"
if [[ $ENV_FILE_EXPLICIT -eq 0 ]]; then
  ENV_FILE="$REPO_ROOT/.env"
fi
if [[ $OUTPUT_DIR_EXPLICIT -eq 0 ]]; then
  OUTPUT_DIR="$REPO_ROOT/backups"
fi
ENV_FILE="$(resolve_abs_path "$ENV_FILE")"
OUTPUT_DIR="$(resolve_abs_path "$OUTPUT_DIR")"

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

[[ -d "$CONFIG_DIR" ]] || fail "Config directory does not exist: $CONFIG_DIR"
[[ -d "$WORKSPACE_DIR" ]] || fail "Workspace directory does not exist: $WORKSPACE_DIR"
[[ -d "$REPO_ROOT" ]] || fail "Repo root does not exist: $REPO_ROOT"
validate_migration_layout "$CONFIG_DIR" "$WORKSPACE_DIR" "$AUTH_PROFILE_SECRET_DIR" "$ENV_FILE"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="${BACKUP_NAME:-openclaw-backup-${timestamp}}"
case "$BACKUP_NAME" in
  -*|*[!/A-Za-z0-9._-]*|*/*|.*|*..*)
    fail "--name must be a simple filename prefix using letters, numbers, dot, underscore, or dash"
    ;;
esac
umask 077
mkdir -p "$OUTPUT_DIR"

archive_path="$OUTPUT_DIR/${BACKUP_NAME}.tar.gz"
checksum_path="${archive_path}.sha256"
[[ ! -e "$archive_path" ]] || fail "Backup output already exists: $archive_path"
[[ ! -e "$checksum_path" ]] || fail "Backup output already exists: $checksum_path"

tmpdir="$(mktemp -d)"
compose_file="$REPO_ROOT/docker-compose.yml"
restart_gateway=0
paused_gateway_container_ids=()
archive_tmp=""
checksum_tmp=""
published_archive=0
published_checksum=0
backup_complete=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ $backup_complete -eq 0 ]]; then
    if [[ $published_archive -eq 1 ]]; then
      rm -f "$archive_path"
    fi
    if [[ $published_checksum -eq 1 ]]; then
      rm -f "$checksum_path"
    fi
  fi
  if [[ -n "$archive_tmp" ]]; then
    rm -f "$archive_tmp"
  fi
  if [[ -n "$checksum_tmp" ]]; then
    rm -f "$checksum_tmp"
  fi
  rm -rf "$tmpdir"
  if [[ $restart_gateway -eq 1 ]]; then
    echo "==> Restarting gateway container"
    if ! docker compose -f "$compose_file" start openclaw-gateway >/dev/null; then
      echo "ERROR: Backup finished, but openclaw-gateway could not be restarted." >&2
      status=1
    else
      for gateway_container_id in "${paused_gateway_container_ids[@]}"; do
        if ! gateway_state="$(docker inspect --format '{{.State.Status}}' "$gateway_container_id")"; then
          echo "ERROR: Backup finished, but the restored gateway state could not be inspected." >&2
          status=1
          continue
        fi
        if [[ "$gateway_state" != "paused" ]] && ! docker pause "$gateway_container_id" >/dev/null; then
          echo "ERROR: Backup finished, but openclaw-gateway could not be paused again." >&2
          status=1
        fi
      done
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stage="$tmpdir/stage"
mkdir -p "$stage/payload/config" "$stage/payload/workspace" "$stage/payload/repo" "$stage/meta"

if [[ $STOP_FIRST -eq 1 ]]; then
  require_cmd docker
  [[ -f "$compose_file" ]] || fail "Compose file not found at $compose_file (use --no-stop only if the gateway is already stopped)."
  if ! gateway_container_ids="$(
    docker compose -f "$compose_file" ps --all -q openclaw-gateway 2>/dev/null
  )"; then
    fail "Failed to inspect openclaw-gateway. Fix Docker/Compose first or use --no-stop only if the gateway is already stopped."
  fi
  gateway_is_active=0
  while IFS= read -r gateway_container_id; do
    [[ -n "$gateway_container_id" ]] || continue
    if ! gateway_state="$(docker inspect --format '{{.State.Status}}' "$gateway_container_id")"; then
      fail "Failed to inspect openclaw-gateway container state: $gateway_container_id"
    fi
    case "$gateway_state" in
      running | restarting)
        gateway_is_active=1
        ;;
      paused)
        gateway_is_active=1
        paused_gateway_container_ids+=("$gateway_container_id")
        ;;
    esac
  done <<<"$gateway_container_ids"
  if [[ $gateway_is_active -eq 1 ]]; then
    # From the first lifecycle mutation onward, the EXIT trap must return every
    # originally active container to its prior running/paused state.
    restart_gateway=1
    for gateway_container_id in "${paused_gateway_container_ids[@]}"; do
      docker unpause "$gateway_container_id" >/dev/null || fail "Failed to unpause openclaw-gateway before backup."
    done
    echo "==> Stopping gateway container for a consistent backup"
    if ! docker compose -f "$compose_file" stop openclaw-gateway >/dev/null; then
      fail "Failed to stop openclaw-gateway; no backup was created."
    fi
    while IFS= read -r gateway_container_id; do
      [[ -n "$gateway_container_id" ]] || continue
      if ! gateway_state="$(docker inspect --format '{{.State.Status}}' "$gateway_container_id")"; then
        fail "Failed to verify stopped openclaw-gateway state: $gateway_container_id"
      fi
      case "$gateway_state" in
        running | restarting | paused)
          fail "openclaw-gateway remained active after stop (state=$gateway_state); no backup was created."
          ;;
      esac
    done <<<"$gateway_container_ids"
  fi
fi

echo "==> Copying config directory"
config_rsync_args=(-a)
if [[ "$WORKSPACE_DIR" == "$CONFIG_DIR"/* ]]; then
  nested_workspace_rel="${WORKSPACE_DIR#$CONFIG_DIR/}"
  if [[ -n "$nested_workspace_rel" ]]; then
    config_rsync_args+=(--exclude="/${nested_workspace_rel}/")
  fi
fi
rsync "${config_rsync_args[@]}" "$CONFIG_DIR/" "$stage/payload/config/"

echo "==> Copying workspace directory"
rsync -a "$WORKSPACE_DIR/" "$stage/payload/workspace/"

if [[ -d "$AUTH_PROFILE_SECRET_DIR" ]]; then
  echo "==> Copying auth-profile secret directory"
  mkdir -p "$stage/payload/auth-profile-secrets"
  rsync -a "$AUTH_PROFILE_SECRET_DIR/" "$stage/payload/auth-profile-secrets/"
else
  echo "WARNING: auth-profile secret directory not found; skipping: $AUTH_PROFILE_SECRET_DIR" >&2
fi

# Validate the completed, quiesced copy rather than the live source tree. This
# closes the mutation window and guarantees every published archive is accepted
# by the restore helper's payload-root link policy.
python3 - \
  "$stage/payload/config" \
  "$stage/payload/workspace" \
  "$stage/payload/auth-profile-secrets" <<'PY'
import os
import sys


def fail(path, target):
    raise SystemExit(f"Backup contains symlink outside its migrated directory: {path} -> {target}")


for root in sys.argv[1:]:
    if not os.path.isdir(root):
        continue
    root_path = os.path.abspath(root)
    for current, directories, files in os.walk(root_path, followlinks=False):
        for name in [*directories, *files]:
            path = os.path.join(current, name)
            if not os.path.islink(path):
                continue
            target = os.readlink(path)
            if os.path.isabs(target):
                fail(path, target)
            resolved_target = os.path.abspath(os.path.join(current, target))
            try:
                inside_root = os.path.commonpath([root_path, resolved_target]) == root_path
            except ValueError:
                inside_root = False
            if not inside_root:
                fail(path, target)
PY

if [[ -f "$ENV_FILE" ]]; then
  echo "==> Including env file: $ENV_FILE"
  cp "$ENV_FILE" "$stage/payload/repo/.env"
fi

for file in Dockerfile docker-compose.yml docker-compose.persistence.yml docker-compose.override.yml docker-compose.extra.yml scripts/docker/setup.sh; do
  if [[ -f "$REPO_ROOT/$file" ]]; then
    mkdir -p "$stage/payload/repo/$(dirname "$file")"
    cp "$REPO_ROOT/$file" "$stage/payload/repo/$file"
  fi
done

{
  echo "timestamp_utc=$timestamp"
  echo "source_host=$(hostname -s || hostname)"
  echo "source_arch=$(uname -m)"
  echo "source_os=$(uname -s)"
  echo "repo_root=$REPO_ROOT"
  echo "config_dir=$CONFIG_DIR"
  echo "workspace_dir=$WORKSPACE_DIR"
  echo "auth_profile_secret_dir=$AUTH_PROFILE_SECRET_DIR"
} >"$stage/meta/backup.env"

if command -v docker >/dev/null 2>&1; then
  {
    echo "# docker version"
    docker version --format '{{.Server.Version}}' 2>/dev/null || true
    echo
    echo "# docker compose ps"
    docker compose -f "$REPO_ROOT/docker-compose.yml" ps 2>/dev/null || true
  } >"$stage/meta/docker.txt"
fi

if command -v git >/dev/null 2>&1 && [[ -d "$REPO_ROOT/.git" ]]; then
  {
    echo "branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
    echo "commit=$(git -C "$REPO_ROOT" rev-parse HEAD)"
    echo
    echo "# status"
    git -C "$REPO_ROOT" status --short
  } >"$stage/meta/git.txt"
fi

(
  python3 - "$stage" <<'PY'
import hashlib
import os
import stat
import sys

stage = sys.argv[1]
entries = []
for root, dirs, files in os.walk(stage):
    dirs.sort()
    files.sort()
    for name in files:
        path = os.path.join(root, name)
        rel = os.path.relpath(path, stage)
        if rel == "SHA256SUMS":
            continue
        mode = os.lstat(path).st_mode
        if not stat.S_ISREG(mode):
            continue
        entries.append(rel)

with open(os.path.join(stage, "SHA256SUMS"), "w", encoding="utf-8") as out:
    for rel in sorted(entries):
        digest = hashlib.sha256()
        with open(os.path.join(stage, rel), "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        manifest_path = f"./{rel}"
        if "\\" in manifest_path or "\n" in manifest_path:
            escaped_path = manifest_path.replace("\\", "\\\\").replace("\n", "\\n")
            out.write(f"\\{digest.hexdigest()}  {escaped_path}\n")
        else:
            out.write(f"{digest.hexdigest()}  {manifest_path}\n")
PY
)

archive_tmp="$(mktemp "$OUTPUT_DIR/.${BACKUP_NAME}.archive.XXXXXX")"
checksum_tmp="$(mktemp "$OUTPUT_DIR/.${BACKUP_NAME}.checksum.XXXXXX")"
(
  cd "$stage"
  tar -czf "$archive_tmp" .
)
archive_digest="$(shasum -a 256 "$archive_tmp" | awk 'NR == 1 { print $1 }')"
[[ -n "$archive_digest" ]] || fail "Failed to calculate backup archive checksum"
printf '%s  ./%s\n' "$archive_digest" "$(basename "$archive_path")" >"$checksum_tmp"
chmod 600 "$archive_tmp" "$checksum_tmp"

# Publish the archive last so every visible archive already has its checksum.
ln "$checksum_tmp" "$checksum_path" || fail "Backup output appeared during creation: $checksum_path"
published_checksum=1
ln "$archive_tmp" "$archive_path" || fail "Backup output appeared during creation: $archive_path"
published_archive=1
backup_complete=1
rm -f "$archive_tmp" "$checksum_tmp"
archive_tmp=""
checksum_tmp=""

echo
echo "Backup created:"
echo "  $archive_path"
echo "  $checksum_path"
echo
echo "Next step on target host:"
echo "  scripts/migrate/restore-openclaw.sh --archive \"$archive_path\""
