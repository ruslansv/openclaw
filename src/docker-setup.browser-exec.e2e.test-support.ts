import type { SpawnSyncReturns } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  prestartContainerEnvFlags,
  readDockerLog,
  resetDockerLog,
  type DockerSetupSandbox,
} from "./docker-setup.e2e.test-support.js";

type DockerSetupRunner = (
  sandbox: DockerSetupSandbox,
  overrides?: Record<string, string | undefined>,
  args?: string[],
) => SpawnSyncReturns<string>;

export function registerDockerSetupBrowserExecTests(
  getSandbox: () => DockerSetupSandbox,
  runDockerSetup: DockerSetupRunner,
): void {
  it("configures Docker browser defaults when OPENCLAW_INSTALL_BROWSER is enabled", async () => {
    const activeSandbox = getSandbox();
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_INSTALL_BROWSER: "1",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_BROWSER=1");
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config set browser.enabled true`,
    );
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config set browser.defaultProfile openclaw`,
    );
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config set browser.headless true`,
    );
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config set browser.noSandbox true`,
    );
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config set browser.executablePath /usr/local/bin/openclaw-playwright-chromium`,
    );
  });

  it("preserves explicit browser config when Docker browser defaults are applied", async () => {
    const activeSandbox = getSandbox();
    await resetDockerLog(activeSandbox);
    const configDir = join(activeSandbox.rootDir, "config-browser-explicit");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-browser-explicit");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "openclaw.json"),
      `{
        // JSON5 syntax should still count as explicitly configured.
        browser: {
          enabled: false,
          headless: false,
          executablePath: "/custom/browser",
        },
      }
      `,
    );

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_INSTALL_BROWSER: "1",
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config get browser.enabled`,
    );
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config get browser.executablePath`,
    );
    expect(log).not.toContain("config set browser.enabled true");
    expect(log).not.toContain("config set browser.headless true");
    expect(log).not.toContain(
      "config set browser.executablePath /usr/local/bin/openclaw-playwright-chromium",
    );
    expect(log).toContain("config set browser.defaultProfile openclaw");
    expect(log).toContain("config set browser.noSandbox true");
  });

  it("skips Docker browser defaults when the selected image lacks Chromium", async () => {
    const activeSandbox = getSandbox();
    await resetDockerLog(activeSandbox);

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_IMAGE: "ghcr.io/openclaw/openclaw:latest",
      OPENCLAW_INSTALL_BROWSER: "1",
      DOCKER_STUB_BROWSER_AVAILABLE: "0",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain("openclaw-playwright-chromium --version");
    expect(log).not.toContain("config set browser.enabled true");
    expect(log).not.toContain("config set browser.defaultProfile openclaw");
    expect(log).not.toContain("config set browser.headless true");
    expect(log).not.toContain("config set browser.noSandbox true");
    expect(log).not.toContain(
      "config set browser.executablePath /usr/local/bin/openclaw-playwright-chromium",
    );
  });

  it("applies Docker exec policy defaults and preserves existing allowlist entries", async () => {
    const activeSandbox = getSandbox();
    await resetDockerLog(activeSandbox);
    const configDir = join(activeSandbox.rootDir, "config-exec-policy");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-exec-policy");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
        },
        agents: {
          main: {
            allowlist: [{ pattern: "/usr/bin/uname" }],
          },
        },
      }),
    );

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_DOCKER_EXEC_SECURITY: "full",
      OPENCLAW_DOCKER_EXEC_ASK: "off",
      OPENCLAW_DOCKER_EXEC_ASK_FALLBACK: "full",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config set tools.exec.security full`,
    );
    expect(log).toContain(
      `run --rm --no-deps ${prestartContainerEnvFlags} --entrypoint node openclaw-gateway dist/index.js config set tools.exec.ask off`,
    );
    expect(log).toContain("run --rm --no-deps --user node --entrypoint node openclaw-gateway -e");

    const envFile = await readFile(join(activeSandbox.rootDir, ".env"), "utf8");
    expect(envFile).toContain("OPENCLAW_DOCKER_EXEC_SECURITY=full");
    expect(envFile).toContain("OPENCLAW_DOCKER_EXEC_ASK=off");
    expect(envFile).toContain("OPENCLAW_DOCKER_EXEC_ASK_FALLBACK=full");

    const approvals = JSON.parse(await readFile(join(configDir, "exec-approvals.json"), "utf8"));
    expect(approvals.defaults).toMatchObject({
      security: "full",
      ask: "off",
      askFallback: "full",
    });
    expect(approvals.agents.main).toMatchObject({
      security: "full",
      ask: "off",
      askFallback: "full",
    });
    expect(approvals.agents.main.allowlist).toEqual([{ pattern: "/usr/bin/uname" }]);
  });

  it("rejects array-valued exec approval records without claiming alignment", async () => {
    const activeSandbox = getSandbox();
    await resetDockerLog(activeSandbox);
    const configDir = join(activeSandbox.rootDir, "config-exec-policy-array");
    const workspaceDir = join(activeSandbox.rootDir, "workspace-exec-policy-array");
    const approvalsPath = join(configDir, "exec-approvals.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(approvalsPath, JSON.stringify({ version: 1, defaults: [], agents: {} }));

    const result = runDockerSetup(activeSandbox, {
      OPENCLAW_CONFIG_DIR: configDir,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
      OPENCLAW_DOCKER_EXEC_SECURITY: "full",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("defaults must be a JSON object");
    expect(result.stdout).not.toContain("Aligned exec approvals defaults");
    expect(JSON.parse(await readFile(approvalsPath, "utf8"))).toEqual({
      version: 1,
      defaults: [],
      agents: {},
    });
    const log = await readDockerLog(activeSandbox);
    expect(log).not.toContain("config set tools.exec.security full");
  });
}
