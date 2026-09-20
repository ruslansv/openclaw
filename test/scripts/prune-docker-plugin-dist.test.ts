// Prune Docker Plugin Dist tests cover prune docker plugin dist script behavior.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneDockerPluginDist } from "../../scripts/prune-docker-plugin-dist.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("pruneDockerPluginDist", () => {
  it("refuses to prune plugin trees through a symlinked dist root", () => {
    const rootDir = createTempDir("openclaw-prune-docker-dist-symlink-");
    const targetDir = path.join(rootDir, "gateway-dist");
    const pluginFile = path.join(targetDir, "extensions", "telegram", "index.js");
    fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
    fs.writeFileSync(pluginFile, "export {};\n");
    const distLink = path.join(rootDir, "dist");
    fs.symlinkSync(targetDir, distLink, "dir");

    expect(() => pruneDockerPluginDist({ cwd: rootDir, env: {} })).toThrow(/symbolic link/u);

    expect(fs.readlinkSync(distLink)).toBe(targetDir);
    expect(fs.readFileSync(pluginFile, "utf8")).toBe("export {};\n");
  });

  it("links Docker-selected plugin dependencies for unified and plugin-local chunks", () => {
    const rootDir = createTempDir("openclaw-prune-docker-selected-");
    const packageName = "@vendor/runtime";
    const pluginDir = path.join(rootDir, "extensions", "slack");
    const sourcePackage = path.join(pluginDir, "node_modules", "@vendor", "runtime");
    const distPlugin = path.join(rootDir, "dist", "extensions", "slack");
    fs.mkdirSync(sourcePackage, { recursive: true });
    fs.mkdirSync(distPlugin, { recursive: true });
    fs.mkdirSync(path.join(rootDir, "dist-runtime"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ files: ["!dist/extensions/slack/**"] }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/slack", dependencies: { [packageName]: "1.0.0" } }),
    );
    fs.writeFileSync(
      path.join(sourcePackage, "package.json"),
      JSON.stringify({ name: packageName, version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(distPlugin, "index.js"), `import ${JSON.stringify(packageName)};\n`);

    pruneDockerPluginDist({
      cwd: rootDir,
      env: { OPENCLAW_EXTENSIONS: "slack" },
    });

    expect(fs.realpathSync(path.join(rootDir, "node_modules", packageName))).toBe(sourcePackage);
    expect(fs.realpathSync(path.join(distPlugin, "node_modules", packageName))).toBe(sourcePackage);
  });
});
