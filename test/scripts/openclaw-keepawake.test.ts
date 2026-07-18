import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/openclaw-keepawake.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let caffeinatePid: number | undefined;

afterEach(() => {
  if (caffeinatePid) {
    try {
      process.kill(caffeinatePid, "SIGTERM");
    } catch {
      // The off command already stopped it.
    }
    caffeinatePid = undefined;
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
    await writeFile(psStub, "#!/bin/sh\nprintf '%s\\n' /usr/bin/caffeinate\n");
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
    caffeinatePid = Number(readFileSync(pidFile, "utf8").trim());
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
});
