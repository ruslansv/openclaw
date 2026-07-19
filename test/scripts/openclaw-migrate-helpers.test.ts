// Docker migration helper tests cover host-state backup and restore invariants.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
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

async function writeDockerStub(root: string, repoRoot: string) {
  const binDir = path.join(root, "bin");
  const dockerLog = path.join(root, "docker.log");
  const composePath = path.join(repoRoot, "docker-compose.yml");
  await mkdir(binDir, { recursive: true });
  await writeFile(composePath, "services:\n  openclaw-gateway:\n    image: test\n");
  const dockerStub = path.join(binDir, "docker");
  await writeFile(
    dockerStub,
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case " $* " in
  *" ps --status running -q openclaw-gateway "*) printf '%s\\n' test-container ;;
  *" stop openclaw-gateway "*)
    if [ -n "\${DOCKER_REMOVE_ON_STOP:-}" ]; then rm -rf -- "$DOCKER_REMOVE_ON_STOP"; fi
    ;;
esac
`,
  );
  await chmod(dockerStub, 0o755);
  return { binDir, composePath, dockerLog };
}

describe("openclaw Docker migration helpers", () => {
  beforeEach(() => {
    tempRoot = tempDirs.make("openclaw-migrate-helper-");
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
    const { binDir, composePath, dockerLog } = await writeDockerStub(root, repoRoot);
    await writeFixtureFile(path.join(configDir, "openclaw.json"), '{"ok":true}\n');
    await writeFixtureFile(path.join(configDir, "odd\nname.txt"), "newline-safe\n");
    const fifoPath = path.join(configDir, "runtime.fifo");
    const fifo = spawnSync("mkfifo", [fifoPath]);
    expect(fifo.status).toBe(0);
    await writeFixtureFile(
      path.join(configDir, "extensions", "tracked-plugin", "package.json"),
      '{"name":"tracked-plugin"}\n',
    );
    await writeFixtureFile(path.join(configDir, "npm", "projects", "native.bin"), "source\n");
    await writeFixtureFile(path.join(configDir, "git", "tracked-plugin", "native.bin"), "source\n");
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

    const backup = runScript(
      BACKUP_SCRIPT,
      ["--repo-root", repoRoot, "--output-dir", backupDir, "--name", "sample"],
      {
        DOCKER_LOG: dockerLog,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    );
    expect(backup.stderr).toBe("");
    expect(backup.status).toBe(0);

    const dockerCalls = readFileSync(dockerLog, "utf8");
    const stopCall = `compose -f ${composePath} stop openclaw-gateway`;
    const startCall = `compose -f ${composePath} start openclaw-gateway`;
    expect(dockerCalls).toContain("ps --status running -q openclaw-gateway");
    expect(dockerCalls.indexOf(stopCall)).toBeGreaterThanOrEqual(0);
    expect(dockerCalls.indexOf(startCall)).toBeGreaterThan(dockerCalls.indexOf(stopCall));

    const archivePath = path.join(backupDir, "sample.tar.gz");
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(`${archivePath}.sha256`)).toBe(true);
    expect(statSync(archivePath).mode & 0o077).toBe(0);
    expect(statSync(`${archivePath}.sha256`).mode & 0o077).toBe(0);

    await writeFixtureFile(path.join(restoredConfigDir, "stale.json"), "{}\n");
    await writeFixtureFile(path.join(restoredWorkspaceDir, "stale.txt"), "old\n");
    await writeFixtureFile(path.join(restoredAuthProfileSecretDir, "stale.key"), "old\n");
    writeFileSync(path.join(repoRoot, ".env"), "OPENCLAW_GATEWAY_TOKEN=old\n");
    const unameStub = path.join(binDir, "uname");
    await writeFile(unameStub, "#!/usr/bin/env sh\nprintf '%s\\n' test-target-arch\n");
    await chmod(unameStub, 0o755);

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
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    expect(restore.stderr).toBe("");
    expect(restore.status).toBe(0);

    expect(readFileSync(path.join(restoredConfigDir, "openclaw.json"), "utf8")).toBe(
      '{"ok":true}\n',
    );
    expect(readFileSync(path.join(restoredConfigDir, "odd\nname.txt"), "utf8")).toBe(
      "newline-safe\n",
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
    expect(statSync(path.join(repoRoot, ".env")).mode & 0o077).toBe(0);

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
    const { binDir, composePath, dockerLog } = await writeDockerStub(root, repoRoot);

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
});
