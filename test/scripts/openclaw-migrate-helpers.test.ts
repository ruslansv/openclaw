// Docker migration helper tests cover host-state backup and restore invariants.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const BACKUP_SCRIPT = "scripts/migrate/backup-openclaw.sh";
const RESTORE_SCRIPT = "scripts/migrate/restore-openclaw.sh";

let tempRoot: string | undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runScript(script: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      HOME: path.join(tempRoot ?? tmpdir(), "home"),
      PATH: process.env.PATH ?? "",
      ...extraEnv,
    },
    timeout: 30_000,
  });
}

async function writeFixtureFile(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value);
}

function dotenvLiteral(value: string) {
  return `'${value.replaceAll("'", "\\'")}'`;
}

async function writeDockerStub(root: string, repoRoot: string, initialState = "restarting") {
  const binDir = path.join(root, "bin");
  const dockerLog = path.join(root, "docker.log");
  const dockerStateFile = path.join(root, "docker-state");
  const composePath = path.join(repoRoot, "docker-compose.yml");
  await mkdir(binDir, { recursive: true });
  await writeFile(dockerStateFile, `${initialState}\n`);
  await writeFile(composePath, "services:\n  openclaw-gateway:\n    image: test\n");
  const dockerStub = path.join(binDir, "docker");
  await writeFile(
    dockerStub,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  *" ps --all -q openclaw-gateway "*) printf '%s\\n' test-container ;;
  *" inspect --format {{.State.Status}} test-container "*) cat "$DOCKER_STATE_FILE" ;;
  *" unpause test-container "*) printf '%s\\n' running > "$DOCKER_STATE_FILE" ;;
  *" pause test-container "*) printf '%s\\n' paused > "$DOCKER_STATE_FILE" ;;
  *" stop openclaw-gateway "*)
    printf '%s\\n' exited > "$DOCKER_STATE_FILE"
    if [ -n "\${DOCKER_REMOVE_ON_STOP:-}" ]; then rm -rf -- "$DOCKER_REMOVE_ON_STOP"; fi
    ;;
  *" start openclaw-gateway "*) printf '%s\\n' running > "$DOCKER_STATE_FILE" ;;
esac
`,
  );
  await chmod(dockerStub, 0o755);
  const mvStub = path.join(binDir, "mv");
  await writeFile(
    mvStub,
    `#!/usr/bin/env bash
set -eu
if [ "$#" -eq 2 ] && [ -n "\${MV_FAIL_DEST:-}" ] && [[ "$1" == *restore-staging-* ]] && [ "$2" = "$MV_FAIL_DEST" ]; then
  exit 1
fi
exec /bin/mv "$@"
`,
  );
  await chmod(mvStub, 0o755);
  return { binDir, composePath, dockerLog, dockerStateFile };
}

describe("openclaw Docker migration helpers", () => {
  beforeEach(() => {
    tempRoot = realpathSync(tempDirs.make("openclaw-migrate-helper-"));
  });

  it("backs up and restores config, workspace, auth-profile secrets, and archive permissions", async () => {
    const root = tempRoot;
    if (!root) {
      throw new Error("missing temp root");
    }

    const repoRoot = path.join(root, "repo");
    const configDir = path.join(root, "config");
    const workspaceDir = path.join(root, "workspace");
    const authProfileSecretDir = path.join(root, "auth-profile-secrets");
    const restoredConfigDir = path.join(root, "restored-$tenant's-config");
    const restoredWorkspaceDir = path.join(root, "restored-$tenant's-workspace");
    const restoredAuthProfileSecretDir = path.join(root, "restored-$tenant's-auth-secrets");
    const backupDir = path.join(root, "backups");
    await mkdir(repoRoot, { recursive: true });
    const { binDir, composePath, dockerLog, dockerStateFile } = await writeDockerStub(
      root,
      repoRoot,
    );
    await writeFixtureFile(path.join(configDir, "openclaw.json"), '{"ok":true}\n');
    await writeFixtureFile(path.join(configDir, "odd\nname.txt"), "newline-safe\n");
    await writeFixtureFile(path.join(configDir, "odd\rname.txt"), "carriage-return-safe\n");
    await writeFixtureFile(
      path.join(configDir, "odd\u2028name.txt"),
      "unicode-line-separator-safe\n",
    );
    const fifoPath = path.join(configDir, "runtime.fifo");
    const fifo = spawnSync("mkfifo", [fifoPath]);
    expect(fifo.status).toBe(0);
    await writeFixtureFile(
      path.join(configDir, "extensions", "tracked-plugin", "package.json"),
      '{"name":"tracked-plugin"}\n',
    );
    await writeFixtureFile(path.join(configDir, "npm", "projects", "native.bin"), "source\n");
    await writeFixtureFile(path.join(configDir, "git", "tracked-plugin", "native.bin"), "source\n");
    await writeFixtureFile(path.join(configDir, "workspace", "stale-from-config.txt"), "stale\n");
    await writeFixtureFile(path.join(workspaceDir, "scripts", "digest.js"), "console.log('ok');\n");
    await writeFixtureFile(
      path.join(workspaceDir, ".openclaw", "extensions", "local-plugin", "package.json"),
      '{"name":"local-plugin"}\n',
    );
    await writeFixtureFile(
      path.join(authProfileSecretDir, "key.json"),
      '{"fixture":"test-value"}\n',
    );
    await writeFile(
      path.join(repoRoot, ".env"),
      [
        `OPENCLAW_CONFIG_DIR=${configDir}`,
        `OPENCLAW_WORKSPACE_DIR=${workspaceDir}`,
        `OPENCLAW_AUTH_PROFILE_SECRET_DIR=${authProfileSecretDir}`,
        "OPENCLAW_GATEWAY_TOKEN=test-token-placeholder",
        "",
      ].join("\n"),
    );
    const unameStub = path.join(binDir, "uname");
    await writeFile(
      unameStub,
      `#!/usr/bin/env sh
case "\${1:-}" in
  -m) printf '%s\\n' "\${UNAME_MACHINE:-x86_64}" ;;
  -s) printf '%s\\n' "\${UNAME_SYSTEM:-Linux}" ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(unameStub, 0o755);
    const sysctlStub = path.join(binDir, "sysctl");
    await writeFile(
      sysctlStub,
      `#!/usr/bin/env sh
case "$*" in
  *hw.optional.arm64*) printf '%s\\n' "\${SYSCTL_HW_OPTIONAL_ARM64:-0}" ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(sysctlStub, 0o755);

    const backup = runScript(
      BACKUP_SCRIPT,
      ["--repo-root", repoRoot, "--output-dir", backupDir, "--name", "sample"],
      {
        DOCKER_LOG: dockerLog,
        DOCKER_STATE_FILE: dockerStateFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        UNAME_MACHINE: "x86_64",
        UNAME_SYSTEM: "Linux",
      },
    );
    expect(backup.stderr).toBe("");
    expect(backup.status).toBe(0);

    const dockerCalls = readFileSync(dockerLog, "utf8");
    const stopCall = `compose -f ${composePath} stop openclaw-gateway`;
    const startCall = `compose -f ${composePath} start openclaw-gateway`;
    expect(dockerCalls).toContain("ps --all -q openclaw-gateway");
    expect(dockerCalls).toContain("inspect --format {{.State.Status}} test-container");
    expect(dockerCalls.indexOf(stopCall)).toBeGreaterThanOrEqual(0);
    expect(dockerCalls.indexOf(startCall)).toBeGreaterThan(dockerCalls.indexOf(stopCall));

    const archivePath = path.join(backupDir, "sample.tar.gz");
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(`${archivePath}.sha256`)).toBe(true);
    expect(statSync(archivePath).mode & 0o077).toBe(0);
    expect(statSync(`${archivePath}.sha256`).mode & 0o077).toBe(0);

    const maliciousStage = path.join(root, "malicious-archive-stage");
    const maliciousArchive = path.join(backupDir, "malicious.tar.gz");
    const symlinkVictim = path.join(root, "symlink-victim.txt");
    await mkdir(maliciousStage);
    await writeFile(symlinkVictim, "unchanged\n");
    expect(spawnSync("tar", ["-xzf", archivePath, "-C", maliciousStage]).status).toBe(0);
    await symlink(symlinkVictim, path.join(maliciousStage, "env.pre-restore"));
    expect(spawnSync("tar", ["-czf", maliciousArchive, "."], { cwd: maliciousStage }).status).toBe(
      0,
    );
    const maliciousDigest = spawnSync("shasum", ["-a", "256", maliciousArchive], {
      encoding: "utf8",
    });
    expect(maliciousDigest.status).toBe(0);
    await writeFile(
      `${maliciousArchive}.sha256`,
      `${maliciousDigest.stdout.trim().split(/\s+/u)[0]}  ./malicious.tar.gz\n`,
    );
    const maliciousRestore = runScript(
      RESTORE_SCRIPT,
      ["--repo-root", repoRoot, "--archive", maliciousArchive, "--no-stop"],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    expect(maliciousRestore.status).not.toBe(0);
    expect(maliciousRestore.stderr).toContain("unexpected archive path: 'env.pre-restore'");
    expect(readFileSync(symlinkVictim, "utf8")).toBe("unchanged\n");

    const archiveBeforeCollision = readFileSync(archivePath);
    const checksumBeforeCollision = readFileSync(`${archivePath}.sha256`);
    const collision = runScript(
      BACKUP_SCRIPT,
      ["--repo-root", repoRoot, "--output-dir", backupDir, "--name", "sample", "--no-stop"],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    expect(collision.status).not.toBe(0);
    expect(collision.stderr).toContain("Backup output already exists");
    expect(readFileSync(archivePath)).toEqual(archiveBeforeCollision);
    expect(readFileSync(`${archivePath}.sha256`)).toEqual(checksumBeforeCollision);

    const leadingDashName = runScript(
      BACKUP_SCRIPT,
      ["--repo-root", repoRoot, "--output-dir", backupDir, "--name", "-snapshot", "--no-stop"],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    expect(leadingDashName.status).not.toBe(0);
    expect(leadingDashName.stderr).toContain("--name must be a simple filename prefix");

    const escapingSymlink = path.join(configDir, "escaping-link");
    await symlink(path.join(root, "outside-config"), escapingSymlink);
    const symlinkBackup = runScript(
      BACKUP_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--output-dir",
        backupDir,
        "--name",
        "symlink-rejected",
        "--no-stop",
      ],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    expect(symlinkBackup.status).not.toBe(0);
    expect(symlinkBackup.stderr).toContain("symlink outside its migrated directory");
    expect(existsSync(path.join(backupDir, "symlink-rejected.tar.gz"))).toBe(false);
    await unlink(escapingSymlink);

    const overlapWorkspaceDir = path.join(root, "overlap-workspace");
    const overlapConfigDir = path.join(overlapWorkspaceDir, "config");
    await writeFixtureFile(path.join(overlapWorkspaceDir, "workspace.txt"), "workspace\n");
    await writeFixtureFile(path.join(overlapConfigDir, "openclaw.json"), "{}\n");
    const overlapBackup = runScript(
      BACKUP_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--config-dir",
        overlapConfigDir,
        "--workspace-dir",
        overlapWorkspaceDir,
        "--auth-profile-secret-dir",
        authProfileSecretDir,
        "--output-dir",
        backupDir,
        "--name",
        "overlap-rejected",
        "--no-stop",
      ],
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    expect(overlapBackup.status).not.toBe(0);
    expect(overlapBackup.stderr).toContain("unsupported overlap");
    expect(existsSync(path.join(backupDir, "overlap-rejected.tar.gz"))).toBe(false);

    const noDockerConfigDir = path.join(root, "no-docker-config");
    const noDockerWorkspaceDir = path.join(root, "no-docker-workspace");
    const noDockerAuthProfileSecretDir = path.join(root, "no-docker-auth-profile-secrets");
    await writeFixtureFile(path.join(noDockerConfigDir, "original.json"), "original\n");
    await writeFixtureFile(path.join(noDockerWorkspaceDir, "original.txt"), "original\n");
    await writeFixtureFile(path.join(noDockerAuthProfileSecretDir, "original.key"), "original\n");
    const noDockerBashEnv = path.join(root, "no-docker.bash-env");
    await writeFile(
      noDockerBashEnv,
      `command() {
  if [[ "\${1:-}" == "-v" && "\${2:-}" == "docker" ]]; then
    return 1
  fi
  builtin command "$@"
}
`,
    );
    const noDockerRestore = runScript(
      RESTORE_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--archive",
        archivePath,
        "--env-file",
        path.join(root, "no-docker.env"),
        "--config-dir",
        noDockerConfigDir,
        "--workspace-dir",
        noDockerWorkspaceDir,
        "--auth-profile-secret-dir",
        noDockerAuthProfileSecretDir,
      ],
      {
        // GitHub's Linux runners install Docker in /usr/bin, so mask only the
        // command lookup under test while leaving restore prerequisites usable.
        BASH_ENV: noDockerBashEnv,
      },
    );
    expect(noDockerRestore.status).not.toBe(0);
    expect(noDockerRestore.stderr).toContain("Missing required command: docker");
    expect(readFileSync(path.join(noDockerConfigDir, "original.json"), "utf8")).toBe("original\n");
    expect(readFileSync(path.join(noDockerWorkspaceDir, "original.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(readFileSync(path.join(noDockerAuthProfileSecretDir, "original.key"), "utf8")).toBe(
      "original\n",
    );

    const rollbackConfigDir = path.join(root, "rollback-config");
    const rollbackWorkspaceDir = path.join(root, "rollback-workspace");
    const rollbackAuthProfileSecretDir = path.join(root, "rollback-auth-profile-secrets");
    await writeFixtureFile(path.join(rollbackConfigDir, "original.json"), "original\n");
    await writeFixtureFile(path.join(rollbackWorkspaceDir, "original.txt"), "original\n");
    await writeFixtureFile(path.join(rollbackAuthProfileSecretDir, "original.key"), "original\n");
    writeFileSync(dockerLog, "");
    const failedRestore = runScript(
      RESTORE_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--archive",
        archivePath,
        "--env-file",
        path.join(root, "rollback.env"),
        "--config-dir",
        rollbackConfigDir,
        "--workspace-dir",
        rollbackWorkspaceDir,
        "--auth-profile-secret-dir",
        rollbackAuthProfileSecretDir,
      ],
      {
        DOCKER_LOG: dockerLog,
        DOCKER_STATE_FILE: dockerStateFile,
        MV_FAIL_DEST: rollbackWorkspaceDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        UNAME_MACHINE: "x86_64",
        UNAME_SYSTEM: "Linux",
      },
    );
    expect(failedRestore.status).not.toBe(0);
    expect(failedRestore.stderr).toContain("rolling back active directories");
    expect(failedRestore.stderr).toContain("Restoring gateway state after failed restore");
    expect(readFileSync(dockerStateFile, "utf8")).toBe("running\n");
    const failedRestoreDockerCalls = readFileSync(dockerLog, "utf8");
    expect(failedRestoreDockerCalls).toContain("ps --all -q openclaw-gateway");
    expect(failedRestoreDockerCalls.indexOf("stop openclaw-gateway")).toBeGreaterThanOrEqual(0);
    expect(failedRestoreDockerCalls.indexOf("start openclaw-gateway")).toBeGreaterThan(
      failedRestoreDockerCalls.indexOf("stop openclaw-gateway"),
    );
    expect(readFileSync(path.join(rollbackConfigDir, "original.json"), "utf8")).toBe("original\n");
    expect(readFileSync(path.join(rollbackWorkspaceDir, "original.txt"), "utf8")).toBe(
      "original\n",
    );
    expect(readFileSync(path.join(rollbackAuthProfileSecretDir, "original.key"), "utf8")).toBe(
      "original\n",
    );
    expect(existsSync(path.join(rollbackConfigDir, "openclaw.json"))).toBe(false);
    expect(existsSync(path.join(rollbackWorkspaceDir, "scripts", "digest.js"))).toBe(false);
    expect(
      readdirSync(root).some(
        (name) => name.startsWith("rollback-") && name.includes(".restore-staging-"),
      ),
    ).toBe(false);
    expect(
      readdirSync(root).some(
        (name) => name.startsWith("rollback-") && name.includes(".pre-restore-"),
      ),
    ).toBe(false);

    await writeFixtureFile(path.join(restoredConfigDir, "stale.json"), "{}\n");
    await writeFixtureFile(path.join(restoredWorkspaceDir, "stale.txt"), "old\n");
    await writeFixtureFile(path.join(restoredAuthProfileSecretDir, "stale.key"), "old\n");
    writeFileSync(path.join(repoRoot, ".env"), "OPENCLAW_GATEWAY_TOKEN=old\n");

    const restore = runScript(
      RESTORE_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--archive",
        archivePath,
        "--config-dir",
        restoredConfigDir,
        "--workspace-dir",
        restoredWorkspaceDir,
        "--auth-profile-secret-dir",
        restoredAuthProfileSecretDir,
        "--no-stop",
        "--apply-env",
      ],
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        SYSCTL_HW_OPTIONAL_ARM64: "1",
        UNAME_MACHINE: "x86_64",
        UNAME_SYSTEM: "Darwin",
      },
    );
    expect(restore.stderr).toBe("");
    expect(restore.status).toBe(0);

    expect(readFileSync(path.join(restoredConfigDir, "openclaw.json"), "utf8")).toBe(
      '{"ok":true}\n',
    );
    expect(readFileSync(path.join(restoredConfigDir, "odd\nname.txt"), "utf8")).toBe(
      "newline-safe\n",
    );
    expect(readFileSync(path.join(restoredConfigDir, "odd\rname.txt"), "utf8")).toBe(
      "carriage-return-safe\n",
    );
    expect(readFileSync(path.join(restoredConfigDir, "odd\u2028name.txt"), "utf8")).toBe(
      "unicode-line-separator-safe\n",
    );
    expect(lstatSync(path.join(restoredConfigDir, "runtime.fifo")).isFIFO()).toBe(true);
    expect(readFileSync(path.join(restoredWorkspaceDir, "scripts", "digest.js"), "utf8")).toBe(
      "console.log('ok');\n",
    );
    expect(readFileSync(path.join(restoredAuthProfileSecretDir, "key.json"), "utf8")).toBe(
      '{"fixture":"test-value"}\n',
    );
    const restoredEnv = readFileSync(path.join(repoRoot, ".env"), "utf8").split("\n");
    expect(restoredEnv).toContain("OPENCLAW_GATEWAY_TOKEN=test-token-placeholder");
    expect(restoredEnv).toContain(`OPENCLAW_CONFIG_DIR=${dotenvLiteral(restoredConfigDir)}`);
    expect(restoredEnv).toContain(`OPENCLAW_WORKSPACE_DIR=${dotenvLiteral(restoredWorkspaceDir)}`);
    expect(restoredEnv).toContain(
      `OPENCLAW_AUTH_PROFILE_SECRET_DIR=${dotenvLiteral(restoredAuthProfileSecretDir)}`,
    );
    expect(restoredEnv).not.toContain(`OPENCLAW_CONFIG_DIR=${configDir}`);
    expect(existsSync(path.join(restoredConfigDir, "extensions"))).toBe(false);
    expect(existsSync(path.join(restoredConfigDir, "npm"))).toBe(false);
    expect(existsSync(path.join(restoredConfigDir, "git"))).toBe(false);
    expect(existsSync(path.join(restoredWorkspaceDir, ".openclaw", "extensions"))).toBe(false);
    const pluginStateName = readdirSync(root).find((name) =>
      name.startsWith("restored-$tenant's-config.source-arch-plugin-state-"),
    );
    expect(pluginStateName).toBeDefined();
    const pluginStateDir = path.join(root, pluginStateName ?? "missing");
    expect(
      readFileSync(
        path.join(pluginStateDir, "config", "extensions", "tracked-plugin", "package.json"),
        "utf8",
      ),
    ).toBe('{"name":"tracked-plugin"}\n');
    expect(
      readFileSync(
        path.join(
          pluginStateDir,
          "workspace",
          ".openclaw",
          "extensions",
          "local-plugin",
          "package.json",
        ),
        "utf8",
      ),
    ).toBe('{"name":"local-plugin"}\n');
    expect(restore.stdout).toContain("plugins update --all");
    expect(restore.stdout).toContain("./scripts/docker/setup.sh");
    expect(restore.stdout).toContain("regenerates required extra/sandbox Compose overlays");
    expect(restore.stdout).not.toContain(`docker compose -f "${repoRoot}/docker-compose.yml" up`);
    expect(statSync(path.join(repoRoot, ".env")).mode & 0o077).toBe(0);
    const previousEnvName = readdirSync(repoRoot).find((name) =>
      name.startsWith(".env.pre-restore-"),
    );
    expect(previousEnvName).toBeDefined();
    expect(statSync(path.join(repoRoot, previousEnvName ?? "missing")).mode & 0o077).toBe(0);

    const nestedConfigDir = path.join(root, "nested-target-config");
    const nestedWorkspaceDir = path.join(nestedConfigDir, "workspace");
    const nestedRestore = runScript(
      RESTORE_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--archive",
        archivePath,
        "--config-dir",
        nestedConfigDir,
        "--workspace-dir",
        nestedWorkspaceDir,
        "--auth-profile-secret-dir",
        path.join(root, "nested-target-auth-secrets"),
        "--no-stop",
      ],
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        UNAME_MACHINE: "x86_64",
        UNAME_SYSTEM: "Linux",
      },
    );
    expect(nestedRestore.stderr).toBe("");
    expect(nestedRestore.status).toBe(0);
    expect(existsSync(path.join(nestedWorkspaceDir, "stale-from-config.txt"))).toBe(false);
    expect(readFileSync(path.join(nestedWorkspaceDir, "scripts", "digest.js"), "utf8")).toBe(
      "console.log('ok');\n",
    );

    const physicalConfigDir = path.join(root, "physical-target-config");
    const symlinkedConfigDir = path.join(root, "symlinked-target-config");
    const physicalWorkspaceDir = path.join(root, "physical-target-workspace");
    await writeFixtureFile(path.join(physicalConfigDir, "stale.json"), "{}\n");
    await symlink(physicalConfigDir, symlinkedConfigDir, "dir");
    const symlinkedRootRestore = runScript(
      RESTORE_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--archive",
        archivePath,
        "--env-file",
        path.join(root, "symlinked-root.env"),
        "--config-dir",
        symlinkedConfigDir,
        "--workspace-dir",
        physicalWorkspaceDir,
        "--auth-profile-secret-dir",
        path.join(root, "symlinked-root-auth-secrets"),
        "--no-stop",
      ],
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        UNAME_MACHINE: "x86_64",
        UNAME_SYSTEM: "Linux",
      },
    );
    expect(symlinkedRootRestore.stderr).toBe("");
    expect(symlinkedRootRestore.status).toBe(0);
    expect(lstatSync(symlinkedConfigDir).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(physicalConfigDir, "openclaw.json"), "utf8")).toBe(
      '{"ok":true}\n',
    );
    expect(existsSync(path.join(physicalConfigDir, "stale.json"))).toBe(false);

    const roundTripBackup = runScript(BACKUP_SCRIPT, [
      "--repo-root",
      repoRoot,
      "--output-dir",
      backupDir,
      "--name",
      "round-trip",
      "--no-stop",
    ]);
    expect(roundTripBackup.stderr).toBe("");
    expect(roundTripBackup.status).toBe(0);

    const candidateEnvFile = path.join(root, "new", "nested", "openclaw.env");
    const candidateRestore = runScript(
      RESTORE_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--archive",
        archivePath,
        "--env-file",
        candidateEnvFile,
        "--config-dir",
        path.join(root, "candidate-config"),
        "--workspace-dir",
        path.join(root, "candidate-workspace"),
        "--auth-profile-secret-dir",
        path.join(root, "candidate-auth-secrets"),
        "--no-stop",
      ],
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        UNAME_MACHINE: "x86_64",
        UNAME_SYSTEM: "Linux",
      },
    );
    expect(candidateRestore.stderr).toBe("");
    expect(candidateRestore.status).toBe(0);
    expect(existsSync(`${candidateEnvFile}.from-backup`)).toBe(true);
    expect(statSync(`${candidateEnvFile}.from-backup`).mode & 0o077).toBe(0);
  });

  it("restarts the gateway when a quiesced backup fails", async () => {
    const root = tempRoot;
    if (!root) {
      throw new Error("missing temp root");
    }

    const repoRoot = path.join(root, "repo-failed-backup");
    const configDir = path.join(root, "failed-config");
    const workspaceDir = path.join(root, "failed-workspace");
    const backupDir = path.join(root, "failed-backups");
    await mkdir(repoRoot, { recursive: true });
    await writeFixtureFile(path.join(configDir, "openclaw.json"), "{}\n");
    await writeFixtureFile(path.join(workspaceDir, "digest.js"), "export {};\n");
    const { binDir, composePath, dockerLog, dockerStateFile } = await writeDockerStub(
      root,
      repoRoot,
    );

    const backup = runScript(
      BACKUP_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--config-dir",
        configDir,
        "--workspace-dir",
        workspaceDir,
        "--output-dir",
        backupDir,
        "--name",
        "failed",
      ],
      {
        DOCKER_LOG: dockerLog,
        DOCKER_REMOVE_ON_STOP: configDir,
        DOCKER_STATE_FILE: dockerStateFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );

    expect(backup.status).not.toBe(0);
    expect(existsSync(path.join(backupDir, "failed.tar.gz"))).toBe(false);
    const dockerCalls = readFileSync(dockerLog, "utf8");
    const stopCall = `compose -f ${composePath} stop openclaw-gateway`;
    const startCall = `compose -f ${composePath} start openclaw-gateway`;
    expect(dockerCalls.indexOf(stopCall)).toBeGreaterThanOrEqual(0);
    expect(dockerCalls.indexOf(startCall)).toBeGreaterThan(dockerCalls.indexOf(stopCall));
  });

  it("returns a paused gateway to its original state after backup", async () => {
    const root = tempRoot;
    if (!root) {
      throw new Error("missing temp root");
    }

    const repoRoot = path.join(root, "repo-paused-backup");
    const configDir = path.join(root, "paused-config");
    const workspaceDir = path.join(root, "paused-workspace");
    const authProfileSecretDir = path.join(root, "paused-auth-profile-secrets");
    const backupDir = path.join(root, "paused-backups");
    await mkdir(repoRoot, { recursive: true });
    await writeFixtureFile(path.join(configDir, "openclaw.json"), "{}\n");
    await writeFixtureFile(path.join(workspaceDir, "digest.js"), "export {};\n");
    await writeFixtureFile(path.join(authProfileSecretDir, "key.json"), "{}\n");
    const { binDir, dockerLog, dockerStateFile } = await writeDockerStub(root, repoRoot, "paused");

    const backup = runScript(
      BACKUP_SCRIPT,
      [
        "--repo-root",
        repoRoot,
        "--config-dir",
        configDir,
        "--workspace-dir",
        workspaceDir,
        "--auth-profile-secret-dir",
        authProfileSecretDir,
        "--output-dir",
        backupDir,
        "--name",
        "paused",
      ],
      {
        DOCKER_LOG: dockerLog,
        DOCKER_STATE_FILE: dockerStateFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );

    expect(backup.stderr).toBe("");
    expect(backup.status).toBe(0);
    expect(readFileSync(dockerStateFile, "utf8")).toBe("paused\n");
    const dockerCalls = readFileSync(dockerLog, "utf8").trim().split("\n");
    expect(dockerCalls.indexOf("unpause test-container")).toBeGreaterThanOrEqual(0);
    expect(dockerCalls.findIndex((call) => call.endsWith("stop openclaw-gateway"))).toBeGreaterThan(
      dockerCalls.indexOf("unpause test-container"),
    );
    expect(
      dockerCalls.findIndex((call) => call.endsWith("start openclaw-gateway")),
    ).toBeGreaterThan(dockerCalls.findIndex((call) => call.endsWith("stop openclaw-gateway")));
    expect(dockerCalls.indexOf("pause test-container")).toBeGreaterThan(
      dockerCalls.findIndex((call) => call.endsWith("start openclaw-gateway")),
    );
  });
});
