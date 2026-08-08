import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/openclaw-keepawake.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let caffeinatePid: number | undefined;
let unrelatedPid: number | undefined;

afterEach(() => {
  if (caffeinatePid) {
    try {
      process.kill(caffeinatePid, "SIGTERM");
    } catch {
      // The off command already stopped it.
    }
    caffeinatePid = undefined;
  }
  if (unrelatedPid) {
    try {
      process.kill(unrelatedPid, "SIGTERM");
    } catch {
      // The test process already exited.
    }
    unrelatedPid = undefined;
  }
});

describe("openclaw keep-awake helper", () => {
  it("tracks caffeinate when macOS ps reports its absolute path", async () => {
    const root = tempDirs.make("openclaw-keepawake-");
    const binDir = path.join(root, "bin");
    const pidFile = path.join(root, "run", "keepawake.pid");
    await mkdir(binDir, { recursive: true });

    const caffeinateStub = path.join(binDir, "caffeinate");
    await writeFile(caffeinateStub, "#!/bin/sh\nexec /bin/sleep 30\n");
    await chmod(caffeinateStub, 0o755);
    const psStub = path.join(binDir, "ps");
    await writeFile(
      psStub,
      `#!/bin/sh
case "$*" in
  *"comm="*) printf '%s\\n' /usr/bin/caffeinate ;;
  *"lstart="*) printf '%s\\n' 'Fri Jul 18 12:00:00 2026' ;;
  *"etime="*) printf '%s\\n' '00:00' ;;
esac
`,
    );
    await chmod(psStub, 0o755);

    const env = {
      ...process.env,
      OPENCLAW_KEEPAWAKE_PID_FILE: pidFile,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const run = (command: string) =>
      spawnSync("bash", [SCRIPT_PATH, command], {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
      });

    const started = run("on");
    expect(started.status).toBe(0);
    expect(started.stderr).toBe("");
    expect(existsSync(pidFile)).toBe(true);
    caffeinatePid = Number(readFileSync(pidFile, "utf8").split("\t", 1)[0]);
    expect(Number.isSafeInteger(caffeinatePid)).toBe(true);
    expect(started.stdout).toContain(`keep-awake on (pid ${caffeinatePid}`);

    const status = run("status");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`keep-awake is on (pid ${caffeinatePid})`);

    const stopped = run("off");
    expect(stopped.status).toBe(0);
    expect(stopped.stdout).toContain(`keep-awake off (stopped pid ${caffeinatePid})`);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("does not stop a reused PID without the recorded start identity", async () => {
    const root = tempDirs.make("openclaw-keepawake-stale-");
    const binDir = path.join(root, "bin");
    const pidFile = path.join(root, "run", "keepawake.pid");
    await mkdir(path.dirname(pidFile), { recursive: true });
    await mkdir(binDir, { recursive: true });

    const psStub = path.join(binDir, "ps");
    await writeFile(
      psStub,
      `#!/bin/sh
case "$*" in
  *"comm="*) printf '%s\\n' /usr/bin/caffeinate ;;
  *"lstart="*) printf '%s\\n' 'Fri Jul 18 12:00:00 2026' ;;
  *"etime="*) printf '%s\\n' '00:00' ;;
esac
`,
    );
    await chmod(psStub, 0o755);

    const unrelated = spawn("/bin/sleep", ["30"]);
    unrelatedPid = unrelated.pid;
    if (!unrelatedPid) {
      throw new Error("failed to start unrelated process");
    }
    await writeFile(pidFile, `${unrelatedPid}\tThu Jul 17 12:00:00 2026\n`);

    const stopped = spawnSync("bash", [SCRIPT_PATH, "off"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_KEEPAWAKE_PID_FILE: pidFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(stopped.status).toBe(0);
    expect(stopped.stdout).toContain("keep-awake off (stale pid file removed)");
    expect(existsSync(pidFile)).toBe(false);
    expect(() => process.kill(unrelatedPid ?? 0, 0)).not.toThrow();
  });

  it("adopts a live PID record written by the previous helper", async () => {
    const root = tempDirs.make("openclaw-keepawake-legacy-");
    const binDir = path.join(root, "bin");
    const pidFile = path.join(root, "run", "keepawake.pid");
    await mkdir(path.dirname(pidFile), { recursive: true });
    await mkdir(binDir, { recursive: true });

    const psStub = path.join(binDir, "ps");
    await writeFile(
      psStub,
      `#!/bin/sh
case "$*" in
  *"comm="*) printf '%s\\n' /usr/bin/caffeinate ;;
  *"lstart="*) printf '%s\\n' 'Fri Jul 18 19:00:00 2026' ;;
  *"etime="*) printf '%s\\n' '00:00' ;;
esac
`,
    );
    await chmod(psStub, 0o755);

    const legacy = spawn("/bin/sleep", ["30"]);
    caffeinatePid = legacy.pid;
    if (!caffeinatePid) {
      throw new Error("failed to start legacy process");
    }
    await writeFile(pidFile, `${caffeinatePid}\n`);

    const status = spawnSync("bash", [SCRIPT_PATH, "status"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_KEEPAWAKE_PID_FILE: pidFile,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TZ: "Pacific/Honolulu",
      },
    });

    expect(status.status).toBe(0);
    expect(status.stdout).toContain(`keep-awake is on (pid ${caffeinatePid})`);
    expect(readFileSync(pidFile, "utf8")).toBe(`${caffeinatePid}\tFri Jul 18 19:00:00 2026\n`);
  });
});
