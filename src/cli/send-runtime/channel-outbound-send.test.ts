import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadChannelOutboundAdapter: vi.fn(),
  bootstrapOutboundChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/outbound/load.js", () => ({
  loadChannelOutboundAdapter: mocks.loadChannelOutboundAdapter,
}));

vi.mock("../../infra/outbound/channel-bootstrap.runtime.js", () => ({
  bootstrapOutboundChannelPlugin: mocks.bootstrapOutboundChannelPlugin,
}));

describe("createChannelOutboundRuntimeSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes media sends through sendMedia and preserves media access", async () => {
    const sendMedia = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-1" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText: vi.fn(),
      sendMedia,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("+15551234567", "caption", {
      cfg: {},
      mediaUrl: "file:///tmp/photo.png",
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
      },
      mediaLocalRoots: ["/tmp/fallback-root"],
      mediaReadFile,
      accountId: "default",
      gifPlayback: true,
    });

    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        to: "+15551234567",
        text: "caption",
        mediaUrl: "file:///tmp/photo.png",
        mediaAccess: {
          localRoots: ["/tmp/workspace"],
          readFile: mediaReadFile,
        },
        mediaLocalRoots: ["/tmp/fallback-root"],
        mediaReadFile,
        accountId: "default",
        gifPlayback: true,
      }),
    );
  });

  it("falls back to sendText for text-only sends", async () => {
    const sendText = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-2" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
      sendMedia: vi.fn(),
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("+15551234567", "hello", {
      cfg: {},
      accountId: "default",
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        to: "+15551234567",
        text: "hello",
        accountId: "default",
      }),
    );
  });

  it("bootstraps a missing outbound adapter before reporting it unavailable", async () => {
    const cfg = { channels: { slack: { enabled: true } } };
    const sendText = vi.fn(async () => ({ channel: "slack", messageId: "slack-bootstrapped" }));
    mocks.loadChannelOutboundAdapter
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ sendText });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "slack" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("user:U123", "hello", {
      cfg,
    });

    expect(mocks.bootstrapOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "slack",
      cfg,
    });
    expect(mocks.loadChannelOutboundAdapter).toHaveBeenCalledTimes(2);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg,
        to: "user:U123",
        text: "hello",
      }),
    );
  });

  it("accepts plugin outbound thread and reply aliases", async () => {
    const sendText = vi.fn(async () => ({ channel: "matrix", messageId: "$reply" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "matrix" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("room:!ops:example.org", "hello thread", {
      cfg: {},
      accountId: "sut",
      replyToId: "$parent",
      threadId: "$thread-root",
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "sut",
        replyToId: "$parent",
        threadId: "$thread-root",
        to: "room:!ops:example.org",
      }),
    );
  });

  it("forwards Slack threadTs alias to threadId", async () => {
    const sendText = vi.fn(async () => ({ channel: "slack", messageId: "slack-1" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "slack" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("C123", "hello", {
      cfg: {},
      threadTs: "1712345678.123456",
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        to: "C123",
        text: "hello",
        threadId: "1712345678.123456",
      }),
    );
  });

  it("prefers canonical thread fields over Slack aliases", async () => {
    const sendText = vi.fn(async () => ({ channel: "slack", messageId: "slack-2" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "slack" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("C123", "hello", {
      cfg: {},
      messageThreadId: "200.000",
      threadId: "150.000",
      threadTs: "100.000",
      replyToMessageId: "400.000",
      replyToId: "300.000",
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        threadId: "200.000",
        replyToId: "400.000",
      }),
    );
  });

  it("falls back to sendText when media is present but sendMedia is unavailable", async () => {
    const sendText = vi.fn(async () => ({ channel: "whatsapp", messageId: "wa-3" }));
    mocks.loadChannelOutboundAdapter.mockResolvedValue({
      sendText,
    });

    const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send.js");
    const mediaReadFile = vi.fn(async () => Buffer.from("pdf"));
    const runtimeSend = createChannelOutboundRuntimeSend({
      channelId: "whatsapp" as never,
      unavailableMessage: "unavailable",
    });

    await runtimeSend.sendMessage("+15551234567", "caption", {
      cfg: {},
      mediaUrl: "file:///tmp/test.pdf",
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
      },
      mediaLocalRoots: ["/tmp/fallback-root"],
      mediaReadFile,
      accountId: "default",
      forceDocument: true,
    });

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {},
        to: "+15551234567",
        text: "caption",
        mediaUrl: "file:///tmp/test.pdf",
        mediaAccess: {
          localRoots: ["/tmp/workspace"],
          readFile: mediaReadFile,
        },
        mediaLocalRoots: ["/tmp/fallback-root"],
        mediaReadFile,
        accountId: "default",
        forceDocument: true,
      }),
    );
  });
});
