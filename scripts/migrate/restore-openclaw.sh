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
extract_dir="$tmpdir/archive"
scratch_dir="$tmpdir/runtime"
mkdir -p "$extract_dir" "$scratch_dir"

archive_checksum="$(awk 'NR == 1 { print $1 }' "${ARCHIVE_PATH}.sha256")"
[[ -n "$archive_checksum" ]] || fail "Archive checksum file is invalid: ${ARCHIVE_PATH}.sha256"
printf '%s  %s\n' "$archive_checksum" "$ARCHIVE_PATH" | shasum -a 256 -c -

python3 - "$ARCHIVE_PATH" <<'PY'
import hashlib
import posixpath
import re
import sys
import tarfile

archive_path = sys.argv[1]
allowed_payload_roots = {"auth-profile-secrets", "config", "repo", "workspace"}
allowed_repo_paths = {
    ".env",
    "Dockerfile",
    "docker-compose.extra.yml",
    "docker-compose.override.yml",
    "docker-compose.persistence.yml",
    "docker-compose.yml",
    "scripts",
    "scripts/docker",
    "scripts/docker/setup.sh",
}
allowed_meta_paths = {"backup.env", "docker.txt", "git.txt"}


def fail(message):
    raise SystemExit(f"Archive validation failed: {message}")


def canonical_member_path(raw_path):
    if "\0" in raw_path or raw_path.startswith("/"):
        fail(f"unsafe member path: {raw_path!r}")
    path = raw_path
    while path.startswith("./"):
        path = path[2:]
    path = path.rstrip("/")
    if path in {"", "."}:
        return "."
    normalized = posixpath.normpath(path)
    if normalized != path or normalized == ".." or normalized.startswith("../"):
        fail(f"unsafe member path: {raw_path!r}")
    return path


def validate_layout(path):
    if path == ".":
        return
    parts = path.split("/")
    if parts[0] == "SHA256SUMS":
        if len(parts) != 1:
            fail(f"unexpected archive path: {path!r}")
        return
    if parts[0] == "meta":
        if len(parts) > 2 or (len(parts) == 2 and parts[1] not in allowed_meta_paths):
            fail(f"unexpected archive path: {path!r}")
        return
    if parts[0] != "payload" or (len(parts) > 1 and parts[1] not in allowed_payload_roots):
        fail(f"unexpected archive path: {path!r}")
    if len(parts) >= 3 and parts[1] == "repo":
        repo_path = "/".join(parts[2:])
        if repo_path not in allowed_repo_paths:
            fail(f"unexpected archive path: {path!r}")


def owning_payload_root(path):
    parts = path.split("/")
    if len(parts) >= 2 and parts[0] == "payload" and parts[1] in allowed_payload_roots:
        return "/".join(parts[:2])
    return None


def validate_link(member_path, link_path, hardlink=False):
    if not link_path or link_path.startswith("/"):
        fail(f"unsafe link target for {member_path!r}: {link_path!r}")
    if hardlink:
        target = canonical_member_path(link_path)
    else:
        target = posixpath.normpath(posixpath.join(posixpath.dirname(member_path), link_path))
        if target == ".." or target.startswith("../"):
            fail(f"unsafe link target for {member_path!r}: {link_path!r}")
        validate_layout(target)
    owner = owning_payload_root(member_path)
    if owner is None or (target != owner and not target.startswith(f"{owner}/")):
        fail(f"link escapes its payload root for {member_path!r}: {link_path!r}")
    return target


def decode_manifest_path(value):
    output = []
    index = 0
    while index < len(value):
        char = value[index]
        if char != "\\":
            output.append(char)
            index += 1
            continue
        index += 1
        if index >= len(value) or value[index] not in {"\\", "n"}:
            fail("invalid escaped path in SHA256SUMS")
        output.append("\n" if value[index] == "n" else "\\")
        index += 1
    return "".join(output)


with tarfile.open(archive_path, "r:gz") as archive:
    members = {}
    for member in archive.getmembers():
        path = canonical_member_path(member.name)
        validate_layout(path)
        if path in members:
            fail(f"duplicate archive path: {path!r}")
        if not (
            member.isdir()
            or member.isreg()
            or member.issym()
            or member.islnk()
            or member.isfifo()
        ):
            fail(f"unsupported archive entry type: {path!r}")
        if (member.issym() or member.islnk()) and path != ".":
            validate_link(path, member.linkname, hardlink=member.islnk())
        if member.isfifo() and owning_payload_root(path) not in {
            "payload/auth-profile-secrets",
            "payload/config",
            "payload/workspace",
        }:
            fail(f"unsupported FIFO location: {path!r}")
        members[path] = member

    required_types = {
        "SHA256SUMS": "file",
        "meta/backup.env": "file",
        "payload/config": "directory",
        "payload/workspace": "directory",
    }
    for path, expected_type in required_types.items():
        member = members.get(path)
        valid = member is not None and (member.isreg() if expected_type == "file" else member.isdir())
        if not valid:
            fail(f"missing required {expected_type}: {path}")

    manifest_file = archive.extractfile(members["SHA256SUMS"])
    if manifest_file is None:
        fail("could not read SHA256SUMS")
    manifest_entries = {}
    manifest_text = manifest_file.read().decode("utf-8")
    if not manifest_text.endswith("\n"):
        fail("SHA256SUMS must end with a newline")
    # Only LF delimits records. Other valid filename characters such as CR,
    # NEL, and Unicode line separators must remain part of the path.
    for raw_line in manifest_text[:-1].split("\n"):
        escaped = raw_line.startswith("\\")
        line = raw_line[1:] if escaped else raw_line
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if match is None:
            fail("invalid SHA256SUMS line")
        manifest_path = decode_manifest_path(match.group(2)) if escaped else match.group(2)
        if not manifest_path.startswith("./"):
            fail(f"unsafe SHA256SUMS path: {manifest_path!r}")
        path = canonical_member_path(manifest_path)
        if path in manifest_entries:
            fail(f"duplicate SHA256SUMS path: {path!r}")
        manifest_entries[path] = match.group(1)

    content_members = {
        path: member
        for path, member in members.items()
        if path != "SHA256SUMS" and (member.isreg() or member.islnk())
    }
    if set(manifest_entries) != set(content_members):
        fail("SHA256SUMS does not exactly cover archive file content")
    for path, member in content_members.items():
        source = archive.extractfile(member)
        if source is None:
            fail(f"could not read archive content: {path!r}")
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
        if digest.hexdigest() != manifest_entries[path]:
            fail(f"checksum mismatch: {path!r}")
PY

echo "==> Extracting archive"
tar -xzf "$ARCHIVE_PATH" -C "$extract_dir"

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
validate_migration_layout "$CONFIG_DIR" "$WORKSPACE_DIR" "$AUTH_PROFILE_SECRET_DIR" "$ENV_FILE"

source_arch="$(grep -E '^source_arch=' "$extract_dir/meta/backup.env" | cut -d= -f2- || true)"
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

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$(dirname "$CONFIG_DIR")" "$(dirname "$WORKSPACE_DIR")" "$(dirname "$AUTH_PROFILE_SECRET_DIR")"

config_backup="${CONFIG_DIR}.pre-restore-${timestamp}"
workspace_backup="${WORKSPACE_DIR}.pre-restore-${timestamp}"
auth_profile_secret_backup="${AUTH_PROFILE_SECRET_DIR}.pre-restore-${timestamp}"
config_staging=""
workspace_staging=""
auth_profile_secret_staging=""
env_staging=""
env_destination=""
env_previous_copy=""
env_previous_backup=""
plugin_payload_created=0
swap_started=0
restore_committed=0
config_original_moved=0
workspace_original_moved=0
auth_profile_secret_original_moved=0
config_installed=0
workspace_installed=0
auth_profile_secret_installed=0
env_installed=0
env_had_original=0
gateway_restore_on_failure=0
paused_gateway_container_ids=()

workspace_is_nested=0
target_workspace_relative=""
if [[ "$WORKSPACE_DIR" == "$CONFIG_DIR"/* ]]; then
  workspace_is_nested=1
  target_workspace_relative="${WORKSPACE_DIR#"$CONFIG_DIR"/}"
fi

restore_cleanup() {
  local status=$?
  trap - EXIT INT TERM
  # Rollback is best-effort across every tree; one failed restoration must not
  # prevent attempts to put the remaining active paths back in place.
  set +e
  if [[ $status -ne 0 && $swap_started -eq 1 && $restore_committed -eq 0 ]]; then
    echo "==> Restore failed; rolling back active directories" >&2
    if [[ $config_installed -eq 1 ]]; then
      rm -rf -- "$CONFIG_DIR"
    fi
    if [[ $workspace_is_nested -eq 0 && $workspace_installed -eq 1 ]]; then
      rm -rf -- "$WORKSPACE_DIR"
    fi
    if [[ $auth_profile_secret_installed -eq 1 ]]; then
      rm -rf -- "$AUTH_PROFILE_SECRET_DIR"
    fi
    if [[ $config_original_moved -eq 1 ]]; then
      mv "$config_backup" "$CONFIG_DIR"
    fi
    if [[ $workspace_original_moved -eq 1 ]]; then
      mv "$workspace_backup" "$WORKSPACE_DIR"
    fi
    if [[ $auth_profile_secret_original_moved -eq 1 ]]; then
      mv "$auth_profile_secret_backup" "$AUTH_PROFILE_SECRET_DIR"
    fi
    if [[ $env_installed -eq 1 ]]; then
      if [[ $env_had_original -eq 1 ]]; then
        cp -p "$env_previous_copy" "$env_destination"
      else
        rm -f -- "$env_destination"
      fi
    fi
    if [[ -n "$env_previous_backup" ]]; then
      rm -f -- "$env_previous_backup"
    fi
  fi
  if [[ $status -ne 0 && $gateway_restore_on_failure -eq 1 ]]; then
    echo "==> Restoring gateway state after failed restore" >&2
    if ! docker compose -f "$REPO_ROOT/docker-compose.yml" start openclaw-gateway >/dev/null; then
      echo "ERROR: Active data was rolled back, but openclaw-gateway could not be restarted." >&2
      status=1
    else
      for gateway_container_id in "${paused_gateway_container_ids[@]}"; do
        if ! gateway_state="$(docker inspect --format '{{.State.Status}}' "$gateway_container_id")"; then
          echo "ERROR: Restored gateway state could not be inspected." >&2
          status=1
          continue
        fi
        if [[ "$gateway_state" != "paused" ]] && ! docker pause "$gateway_container_id" >/dev/null; then
          echo "ERROR: openclaw-gateway could not be returned to its paused state." >&2
          status=1
        fi
      done
    fi
  fi
  if [[ $status -ne 0 && $plugin_payload_created -eq 1 ]]; then
    rm -rf -- "$plugin_payload_backup"
  fi
  for staging_path in \
    "$config_staging" "$workspace_staging" "$auth_profile_secret_staging"; do
    if [[ -n "$staging_path" ]]; then
      rm -rf -- "$staging_path"
    fi
  done
  if [[ -n "$env_staging" ]]; then
    rm -f -- "$env_staging"
  fi
  rm -rf -- "$tmpdir"
  exit "$status"
}
trap - EXIT
trap restore_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ ! -e "$config_backup" ]] || fail "Pre-restore snapshot already exists: $config_backup"
if [[ $workspace_is_nested -eq 0 ]]; then
  [[ ! -e "$workspace_backup" ]] || fail "Pre-restore snapshot already exists: $workspace_backup"
fi
if [[ -d "$extract_dir/payload/auth-profile-secrets" ]]; then
  [[ ! -e "$auth_profile_secret_backup" ]] || fail "Pre-restore snapshot already exists: $auth_profile_secret_backup"
fi

# Build complete replacement trees beside their destinations. Nothing under the
# active paths is moved until every archive payload has copied successfully.
config_staging="$(mktemp -d "${CONFIG_DIR}.restore-staging-${timestamp}.XXXXXX")"
if [[ $workspace_is_nested -eq 1 ]]; then
  workspace_staging="$config_staging/$target_workspace_relative"
  mkdir -p "$workspace_staging"
else
  workspace_staging="$(mktemp -d "${WORKSPACE_DIR}.restore-staging-${timestamp}.XXXXXX")"
fi
if [[ -d "$extract_dir/payload/auth-profile-secrets" ]]; then
  auth_profile_secret_staging="$(mktemp -d "${AUTH_PROFILE_SECRET_DIR}.restore-staging-${timestamp}.XXXXXX")"
fi

echo "==> Restoring config"
config_rsync_args=(-a)
workspace_rsync_args=(-a)
plugin_payload_backup=""
# A workspace can move from outside the config tree into its usual nested
# location. Exclude that destination-relative subtree from the config payload
# so stale files there cannot merge with the authoritative workspace payload.
if [[ $workspace_is_nested -eq 1 ]]; then
  config_rsync_args+=(--exclude="/${target_workspace_relative}/")
fi
if [[ $arch_mismatch -eq 1 ]]; then
  # The replacement trees start empty, so these exclusions cannot leave stale
  # source-architecture plugin roots active after the restore.
  config_rsync_args+=(--exclude=/extensions/ --exclude=/git/ --exclude=/npm/)
  workspace_rsync_args+=(--exclude=/.openclaw/extensions/)

  source_arch_label="${source_arch//[^A-Za-z0-9._-]/_}"
  plugin_payload_backup="${CONFIG_DIR}.source-arch-plugin-state-${source_arch_label}-${timestamp}"
  [[ ! -e "$plugin_payload_backup" ]] || fail "Source-architecture plugin snapshot already exists: $plugin_payload_backup"
  mkdir -p "$plugin_payload_backup/config" "$plugin_payload_backup/workspace/.openclaw"
  plugin_payload_created=1
  for relative_dir in extensions git npm; do
    if [[ -d "$extract_dir/payload/config/$relative_dir" ]]; then
      rsync -a \
        "$extract_dir/payload/config/$relative_dir/" \
        "$plugin_payload_backup/config/$relative_dir/"
    fi
  done
  if [[ -d "$extract_dir/payload/workspace/.openclaw/extensions" ]]; then
    rsync -a \
      "$extract_dir/payload/workspace/.openclaw/extensions/" \
      "$plugin_payload_backup/workspace/.openclaw/extensions/"
  fi
fi
rsync "${config_rsync_args[@]}" "$extract_dir/payload/config/" "$config_staging/"

echo "==> Restoring workspace"
rsync "${workspace_rsync_args[@]}" "$extract_dir/payload/workspace/" "$workspace_staging/"

if [[ -d "$extract_dir/payload/auth-profile-secrets" ]]; then
  echo "==> Restoring auth-profile secret directory"
  rsync -a "$extract_dir/payload/auth-profile-secrets/" "$auth_profile_secret_staging/"
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

if [[ -f "$extract_dir/payload/repo/.env" ]]; then
  if [[ $APPLY_ENV -eq 1 ]]; then
    mkdir -p "$(dirname "$ENV_FILE")"
    env_destination="$ENV_FILE"
    env_previous_backup="${ENV_FILE}.pre-restore-${timestamp}"
    [[ ! -e "$env_previous_backup" ]] || fail "Pre-restore env snapshot already exists: $env_previous_backup"
    if [[ -f "$ENV_FILE" ]]; then
      env_had_original=1
    fi
  else
    mkdir -p "$(dirname "$ENV_FILE")"
    env_destination="${ENV_FILE}.from-backup"
    if [[ -f "$env_destination" ]]; then
      env_had_original=1
    fi
  fi
  env_staging="$(mktemp "$(dirname "$env_destination")/.${env_destination##*/}.restore-${timestamp}.XXXXXX")"
  write_restored_env "$extract_dir/payload/repo/.env" "$env_staging"
  chmod 600 "$env_staging"
fi

if [[ $STOP_FIRST -eq 1 ]]; then
  require_cmd docker
  compose_file="$REPO_ROOT/docker-compose.yml"
  [[ -f "$compose_file" ]] || fail "Compose file not found at $compose_file (use --no-stop to skip stopping the gateway)."
  if ! gateway_container_ids="$(docker compose -f "$compose_file" ps --all -q openclaw-gateway 2>/dev/null)"; then
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
    gateway_restore_on_failure=1
    for gateway_container_id in "${paused_gateway_container_ids[@]}"; do
      docker unpause "$gateway_container_id" >/dev/null || fail "Failed to unpause openclaw-gateway before restore."
    done
    echo "==> Stopping gateway container"
    if ! docker compose -f "$compose_file" stop openclaw-gateway >/dev/null 2>&1; then
      fail "Failed to stop openclaw-gateway. Fix Docker/Compose first or rerun with --no-stop if the gateway is already stopped."
    fi
  fi
fi

# All replacement data is complete. The remaining same-filesystem renames are
# covered by restore_cleanup so a failed swap restores every active tree.
swap_started=1
if [[ -d "$CONFIG_DIR" ]]; then
  mv "$CONFIG_DIR" "$config_backup"
  config_original_moved=1
fi
if [[ $workspace_is_nested -eq 0 && -d "$WORKSPACE_DIR" ]]; then
  mv "$WORKSPACE_DIR" "$workspace_backup"
  workspace_original_moved=1
fi
if [[ -n "$auth_profile_secret_staging" && -d "$AUTH_PROFILE_SECRET_DIR" ]]; then
  mv "$AUTH_PROFILE_SECRET_DIR" "$auth_profile_secret_backup"
  auth_profile_secret_original_moved=1
fi

mv "$config_staging" "$CONFIG_DIR"
config_staging=""
config_installed=1
if [[ $workspace_is_nested -eq 0 ]]; then
  mv "$workspace_staging" "$WORKSPACE_DIR"
  workspace_staging=""
  workspace_installed=1
fi
if [[ -n "$auth_profile_secret_staging" ]]; then
  mv "$auth_profile_secret_staging" "$AUTH_PROFILE_SECRET_DIR"
  auth_profile_secret_staging=""
  auth_profile_secret_installed=1
fi

if [[ -n "$env_staging" ]]; then
  if [[ $env_had_original -eq 1 ]]; then
    env_previous_copy="$scratch_dir/env.pre-restore"
    cp -p "$env_destination" "$env_previous_copy"
    if [[ $APPLY_ENV -eq 1 ]]; then
      cp -p "$env_destination" "$env_previous_backup"
      chmod 600 "$env_previous_backup"
    fi
  fi
  mv "$env_staging" "$env_destination"
  env_staging=""
  env_installed=1
fi

restore_committed=1
gateway_restore_on_failure=0
if [[ -n "$env_destination" ]]; then
  if [[ $APPLY_ENV -eq 1 ]]; then
    echo "==> Applied backed up env file to $ENV_FILE"
  else
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
if [[ -f "$extract_dir/payload/repo/.env" && $APPLY_ENV -eq 0 ]]; then
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
