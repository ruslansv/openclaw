import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { BufferedAgentEvent } from "./server-chat-state.js";
import type { DedupeEntry } from "./server-shared.js";

type StartGatewayDiscovery = typeof import("./server-discovery-runtime.js").startGatewayDiscovery;

const mocks = vi.hoisted(() => ({
  getMachineDisplayName: vi.fn(async () => "Test Machine"),
  startGatewayDiscovery: vi.fn<StartGatewayDiscovery>(async () => ({ bonjourStop: null })),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: mocks.getMachineDisplayName,
}));

vi.mock("./server-discovery-runtime.js", () => ({
  startGatewayDiscovery: mocks.startGatewayDiscovery,
}));

import { startGatewayEarlyRuntime, startGatewayPluginDiscovery } from "./server-startup-early.js";

type StartGatewayEarlyRuntimeParams = Parameters<typeof startGatewayEarlyRuntime>[0];

describe("startGatewayEarlyRuntime", () => {
  beforeEach(() => {
    mocks.getMachineDisplayName.mockClear();
    mocks.startGatewayDiscovery.mockClear();
    mocks.startGatewayDiscovery.mockResolvedValue({ bonjourStop: null });
  });

  it("does not eagerly start the MCP loopback server", async () => {
    const earlyRuntime = await startGatewayEarlyRuntime({
      minimalTestGateway: true,
      cfgAtStart: {} as never,
      port: 18_789,
      gatewayTls: { enabled: false },
      tailscaleMode: "off" as never,
      log: {
        info: (_msg: string) => {},
        warn: (_msg: string) => {},
      },
      logDiscovery: {
        info: (_msg: string) => {},
        warn: (_msg: string) => {},
      },
      nodeRegistry: {} as never,
      broadcast: (_event: string, _payload: unknown) => {},
      nodeSendToAllSubscribed: (_event: string, _payload: unknown) => {},
      getPresenceVersion: () => 0,
      getHealthVersion: () => 0,
      refreshGatewayHealthSnapshot: async (_opts?: { probe?: boolean }) => ({}) as never,
      logHealth: { error: (_msg: string) => {} },
      dedupe: new Map<string, DedupeEntry>(),
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
      chatRunState: {
        abortedRuns: new Map<string, number>(),
        deltaLastBroadcastText: new Map<string, string>(),
        agentDeltaSentAt: new Map<string, number>(),
        bufferedAgentEvents: new Map<string, BufferedAgentEvent>(),
      },
      chatRunBuffers: new Map<string, string>(),
      chatDeltaSentAt: new Map<string, number>(),
      chatDeltaLastBroadcastLen: new Map<string, number>(),
      removeChatRun: () => undefined,
      agentRunSeq: new Map<string, number>(),
      nodeSendToSession: (_sessionKey: string, _event: string, _payload: unknown) => {},
      skillsRefreshDelayMs: 30_000,
      getSkillsRefreshTimer: () => null,
      setSkillsRefreshTimer: (_timer) => {},
      getRuntimeConfig: () => ({}) as never,
    } satisfies StartGatewayEarlyRuntimeParams);

    expect(earlyRuntime).not.toHaveProperty("mcpServer");
  });

  it("starts discovery with the current plugin registry services", async () => {
    const stop = vi.fn(async () => {});
    mocks.startGatewayDiscovery.mockResolvedValueOnce({ bonjourStop: stop } as never);
    const service = {
      pluginId: "bonjour",
      service: { id: "bonjour", advertise: vi.fn() },
    };

    await expect(
      startGatewayPluginDiscovery({
        minimalTestGateway: false,
        cfgAtStart: { discovery: { mdns: { mode: "full" } } } as never,
        port: 19_001,
        gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
        tailscaleMode: "serve" as never,
        logDiscovery: {
          info: () => {},
          warn: () => {},
        },
        pluginRegistry: {
          gatewayDiscoveryServices: [service],
        } as never,
      }),
    ).resolves.toBe(stop);

    const [discoveryParams] = mocks.startGatewayDiscovery.mock.calls.at(-1) ?? [];
    if (discoveryParams === undefined) {
      throw new Error("Expected gateway discovery to start");
    }
    expect(discoveryParams.machineDisplayName).toBe("Test Machine");
    expect(discoveryParams.port).toBe(19_001);
    expect(discoveryParams.gatewayTls).toEqual({ enabled: true, fingerprintSha256: "abc123" });
    expect(discoveryParams.tailscaleMode).toBe("serve");
    expect(discoveryParams.mdnsMode).toBe("full");
    expect(discoveryParams.gatewayDiscoveryServices).toEqual([service]);
  });
});
