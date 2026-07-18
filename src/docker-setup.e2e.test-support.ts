import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { createSuiteTempRootTracker, withTempDir } from "./test-helpers/temp-dir.js";

export const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

export type DockerSetupSandbox = {
  rootDir: string;
  scriptPath: string;
  logPath: string;
  binDir: string;
};

const sandboxRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-docker-setup-" });

export async function setupDockerSetupSandboxRoot(): Promise<void> {
  await sandboxRootTracker.setup();
}

export async function cleanupDockerSetupSandboxRoot(): Promise<void> {
  await sandboxRootTracker.cleanup();
}

async function writeDockerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
fail_match="\${DOCKER_STUB_FAIL_MATCH:-}"
docker_host=""
if [[ "\${1:-}" == "--host" ]]; then
  docker_host="\${2:-}"
  shift 2
fi
sync_exec_approvals() {
  local approvals_path="$OPENCLAW_CONFIG_DIR/exec-approvals.json"
  local security="$1"
  local ask="$2"
  local ask_fallback="$3"

  node - "$approvals_path" "$security" "$ask" "$ask_fallback" <<'NODE'
const fs = require("node:fs");
const [approvalsPath, security, ask, askFallback] = process.argv.slice(2);

let data = {};
if (fs.existsSync(approvalsPath)) {
  data = JSON.parse(fs.readFileSync(approvalsPath, "utf8"));
}

if (!data || typeof data !== "object" || Array.isArray(data)) {
  throw new Error(\`Failed to parse \${approvalsPath}: expected a JSON object\`);
}

data.version ??= 1;
data.defaults = data.defaults && typeof data.defaults === "object" ? data.defaults : {};
data.agents = data.agents && typeof data.agents === "object" ? data.agents : {};
data.agents.main =
  data.agents.main && typeof data.agents.main === "object" ? data.agents.main : {};

for (const target of [data.defaults, data.agents.main]) {
  if (security) target.security = security;
  if (ask) target.ask = ask;
  if (askFallback) target.askFallback = askFallback;
}

fs.writeFileSync(approvalsPath, \`\${JSON.stringify(data, null, 2)}\\n\`, "utf8");
NODE
}
config_path_exists_in_stub() {
  local path="$1"
  local config_path="$OPENCLAW_CONFIG_DIR/openclaw.json"
  if [[ ! -f "$config_path" ]]; then
    return 1
  fi

  node - "$config_path" "$path" <<'NODE'
const fs = require("node:fs");
const vm = require("node:vm");
const configPath = process.argv[2];
const parts = process.argv[3].split(".");

try {
  const source = fs.readFileSync(configPath, "utf8");
  let current = vm.runInNewContext(\`(\${source})\`, Object.create(null), {
    timeout: 1000,
  });
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      process.exit(1);
    }
    current = current[part];
  }
  process.exit(0);
} catch {
  process.exit(1);
}
NODE
}
if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  format=""
  if [[ "\${3:-}" == "-f" || "\${3:-}" == "--format" ]]; then
    format="\${4:-}"
    image="\${5:-}"
  else
    image="\${3:-}"
  fi
  echo "image inspect $image host=$docker_host" >>"$log"
  missing_images=",\${DOCKER_STUB_MISSING_IMAGES:-},"
  if [[ "$missing_images" == *",$image,"* ]]; then
    exit 1
  fi
  if [[ -n "$format" ]]; then
    printf '%s\n' "\${DOCKER_STUB_BROWSER_CONTRACT:-<no value>}"
  fi
  exit 0
fi
if [[ "\${1:-}" == "pull" ]]; then
  echo "pull $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  if [[ -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
    echo "build-fail $*" >>"$log"
    exit 1
  fi
  echo "build DOCKER_BUILDKIT=\${DOCKER_BUILDKIT:-} $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  if [[ -n "$fail_match" && "$*" == *"$fail_match"* ]]; then
    echo "compose-fail $*" >>"$log"
    exit 1
  fi
  if [[ "$*" == *"openclaw-playwright-chromium --version"* ]]; then
    echo "compose $*" >>"$log"
    if [[ "\${DOCKER_STUB_BROWSER_AVAILABLE:-1}" != "1" ]]; then
      exit 1
    fi
    exit 0
  fi
  if [[ "$*" == *"config get tools.sandbox.tools --json"* ]]; then
    echo "compose $*" >>"$log"
    if [[ -n "\${DOCKER_STUB_SANDBOX_TOOLS_JSON:-}" ]]; then
      printf '%s\n' "$DOCKER_STUB_SANDBOX_TOOLS_JSON"
    else
      printf '{}\n'
    fi
    exit 0
  fi
  if [[ "$*" == *"config get agents --json"* ]]; then
    echo "compose $*" >>"$log"
    if [[ -n "\${DOCKER_STUB_AGENTS_JSON:-}" ]]; then
      printf '%s\n' "$DOCKER_STUB_AGENTS_JSON"
    else
      printf '{}\n'
    fi
    exit 0
  fi
  if [[ "$*" == *"dist/index.js config get "* ]]; then
    args=("$@")
    path_index=$((\${#args[@]} - 1))
    if ! config_path_exists_in_stub "\${args[$path_index]}"; then
      echo "compose-fail $*" >>"$log"
      exit 1
    fi
  fi
  if [[ "$*" == *"--entrypoint node openclaw-gateway -e"* && "$*" == *"/home/node/.openclaw/exec-approvals.json"* ]]; then
    args=("$@")
    security_index=$((\${#args[@]} - 3))
    ask_index=$((\${#args[@]} - 2))
    ask_fallback_index=$((\${#args[@]} - 1))
    sync_exec_approvals \
      "\${args[$security_index]}" \
      "\${args[$ask_index]}" \
      "\${args[$ask_fallback_index]}"
    echo "compose $*" >>"$log"
    exit 0
  fi
  echo "compose $*" >>"$log"
  args=("$@")
  for ((i = 0; i + 4 < \${#args[@]}; i++)); do
    if [[ "\${args[$i]}" == "--entrypoint" &&
      "\${args[$((i + 1))]}" == "node" &&
      "\${args[$((i + 2))]}" == "openclaw-gateway" &&
      "\${args[$((i + 3))]}" == "-e" ]]; then
      node -e "\${args[$((i + 4))]}" "\${args[@]:$((i + 5))}"
      exit $?
    fi
  done
  exit 0
fi
echo "unknown $*" >>"$log"
exit 0
`;

  const timeoutStub = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == --kill-after=* ]]; then
  shift
elif [[ "\${1:-}" == "--kill-after" ]]; then
  shift 2
fi
if [[ $# -gt 0 ]]; then
  shift
fi
exec "$@"
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(join(binDir, "timeout"), timeoutStub, { mode: 0o755 });
  await writeFile(logPath, "");
}

export async function expectMissingPath(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${path}`);
}

export async function createDockerSetupSandbox(): Promise<DockerSetupSandbox> {
  const rootDir = await sandboxRootTracker.make("suite");
  const scriptPath = join(rootDir, "scripts", "docker", "setup.sh");
  const dockerfilePath = join(rootDir, "Dockerfile");
  const composePath = join(rootDir, "docker-compose.yml");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "docker-stub.log");

  await mkdir(join(rootDir, "scripts", "docker"), { recursive: true });
  await mkdir(join(rootDir, "scripts", "lib"), { recursive: true });
  await copyFile(join(repoRoot, "scripts", "docker", "setup.sh"), scriptPath);
  await copyFile(
    join(repoRoot, "scripts", "lib", "docker-build.sh"),
    join(rootDir, "scripts", "lib", "docker-build.sh"),
  );
  await copyFile(
    join(repoRoot, "scripts", "lib", "build-metadata.sh"),
    join(rootDir, "scripts", "lib", "build-metadata.sh"),
  );
  await copyFile(
    join(repoRoot, "scripts", "lib", "docker-e2e-logs.sh"),
    join(rootDir, "scripts", "lib", "docker-e2e-logs.sh"),
  );
  await copyFile(
    join(repoRoot, "scripts", "lib", "docker-e2e-container.sh"),
    join(rootDir, "scripts", "lib", "docker-e2e-container.sh"),
  );
  await copyFile(
    join(repoRoot, "scripts", "lib", "docker-e2e-resource-diagnostics.sh"),
    join(rootDir, "scripts", "lib", "docker-e2e-resource-diagnostics.sh"),
  );
  await copyFile(
    join(repoRoot, "scripts", "lib", "host-timeout.sh"),
    join(rootDir, "scripts", "lib", "host-timeout.sh"),
  );
  await chmod(scriptPath, 0o755);
  await writeFile(dockerfilePath, "FROM scratch\n");
  await writeFile(
    composePath,
    "services:\n  openclaw-gateway:\n    image: noop\n  openclaw-cli:\n    image: noop\n",
  );
  await writeDockerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

export const prestartContainerEnvFlags = [
  "-e HOME=/home/node",
  "-e OPENCLAW_HOME=/home/node",
  "-e OPENCLAW_STATE_DIR=/home/node/.openclaw",
  "-e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json",
  "-e OPENCLAW_CONFIG_DIR=/home/node/.openclaw",
  "-e OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace",
].join(" ");

export const noFollowOwnershipRepair = (root: string) =>
  `/usr/bin/find -P ${root} -xdev -execdir /usr/bin/chown -h node:node {} +`;
export const prestartSafePath = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function requireSandbox(sandbox: DockerSetupSandbox | null): DockerSetupSandbox {
  if (!sandbox) {
    throw new Error("sandbox missing");
  }
  return sandbox;
}

export async function resetDockerLog(sandbox: DockerSetupSandbox) {
  await writeFile(sandbox.logPath, "");
}

export async function readDockerLog(sandbox: DockerSetupSandbox) {
  return readFile(sandbox.logPath, "utf8");
}

export async function readDockerLogLines(sandbox: DockerSetupSandbox) {
  const lines: string[] = [];
  for (const line of (await readDockerLog(sandbox)).split("\n")) {
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

export function collectMatchingLines(
  lines: string[],
  predicate: (line: string) => boolean,
): string[] {
  const matches: string[] = [];
  for (const line of lines) {
    if (predicate(line)) {
      matches.push(line);
    }
  }
  return matches;
}

export function isGatewayStartLine(line: string) {
  return line.includes("compose") && line.includes(" up -d") && line.includes("openclaw-gateway");
}

export function findGatewayStartLineIndex(lines: string[]) {
  return lines.findIndex((line) => isGatewayStartLine(line));
}

export function expectOfflineComposePolicy(
  lines: string[],
  options: { gatewayStarts?: boolean } = {},
) {
  const composeLines = collectMatchingLines(lines, (line) => line.startsWith("compose "));
  expect(composeLines.length).toBeGreaterThan(0);
  for (const line of composeLines) {
    if (line.includes(" run ")) {
      expect(line).toContain(" run --pull never ");
    }
  }
  const gatewayStarts = collectMatchingLines(composeLines, (line) => isGatewayStartLine(line));
  if (options.gatewayStarts === false) {
    expect(gatewayStarts).toHaveLength(0);
    return;
  }
  expect(gatewayStarts.length).toBeGreaterThan(0);
  for (const line of gatewayStarts) {
    expect(line).toContain(" up -d --pull never --no-build");
  }
}

export async function withUnixSocket<T>(
  label: string,
  run: (socketPath: string) => Promise<T>,
): Promise<T> {
  return withTempDir({ prefix: `openclaw-${label}-`, parentDir: "/tmp" }, async (socketDir) => {
    // macOS caps Unix socket paths tightly, so keep these test sockets out of
    // the longer per-suite temp root.
    const socketPath = join(socketDir, "docker.sock");
    const server = createServer();
    await new Promise<void>((resolveValue, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveValue();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });

    try {
      return await run(socketPath);
    } finally {
      await new Promise<void>((resolveLocal) => {
        server.close(() => resolveLocal());
      });
      await rm(socketPath, { force: true });
    }
  });
}

export function resolveBashForCompatCheck(): string | null {
  for (const candidate of ["/bin/bash", "bash"]) {
    const probe = spawnSync(candidate, ["-c", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) {
      return candidate;
    }
  }

  return null;
}
