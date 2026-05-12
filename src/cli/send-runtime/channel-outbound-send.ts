import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type RuntimeSendOpts = {
  cfg?: OpenClawConfig;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string;
  threadId?: string | number | null;
  messageThreadId?: string | number;
  threadTs?: string | number;
  replyToId?: string | number | null;
  replyToMessageId?: string | number;
  silent?: boolean;
  forceDocument?: boolean;
  gifPlayback?: boolean;
  gatewayClientScopes?: readonly string[];
};

function resolveRuntimeThreadId(opts: RuntimeSendOpts): string | number | undefined {
  return opts.messageThreadId ?? opts.threadId ?? opts.threadTs ?? undefined;
}

function resolveRuntimeReplyToId(opts: RuntimeSendOpts): string | undefined {
  const raw = opts.replyToMessageId ?? opts.replyToId;
  return raw == null ? undefined : normalizeOptionalString(String(raw));
}

let channelBootstrapRuntimePromise:
  | Promise<typeof import("../../infra/outbound/channel-bootstrap.runtime.js")>
  | undefined;

async function loadChannelBootstrapRuntime() {
  channelBootstrapRuntimePromise ??= import("../../infra/outbound/channel-bootstrap.runtime.js");
  return await channelBootstrapRuntimePromise;
}

async function loadBootstrappedOutboundAdapter(params: {
  channelId: ChannelId;
  resolveConfig: () => OpenClawConfig;
}) {
  let outbound = await loadChannelOutboundAdapter(params.channelId);
  if (!outbound) {
    const { bootstrapOutboundChannelPlugin } = await loadChannelBootstrapRuntime();
    bootstrapOutboundChannelPlugin({
      channel: params.channelId as never,
      cfg: params.resolveConfig(),
    });
    outbound = await loadChannelOutboundAdapter(params.channelId);
  }
  return outbound;
}

export function createChannelOutboundRuntimeSend(params: {
  channelId: ChannelId;
  unavailableMessage: string;
}) {
  return {
    sendMessage: async (to: string, text: string, opts: RuntimeSendOpts = {}) => {
      let resolvedConfig = opts.cfg;
      const resolveConfig = () => (resolvedConfig ??= getRuntimeConfig());
      const outbound = await loadBootstrappedOutboundAdapter({
        channelId: params.channelId,
        resolveConfig,
      });
      const threadId = resolveRuntimeThreadId(opts);
      const replyToId = resolveRuntimeReplyToId(opts);
      const buildContext = () => ({
        cfg: resolveConfig(),
        to,
        text,
        mediaUrl: opts.mediaUrl,
        mediaAccess: opts.mediaAccess,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
        accountId: opts.accountId,
        threadId,
        replyToId,
        silent: opts.silent,
        forceDocument: opts.forceDocument,
        gifPlayback: opts.gifPlayback,
        gatewayClientScopes: opts.gatewayClientScopes,
      });
      const hasMedia = Boolean(opts.mediaUrl);
      if (hasMedia && outbound?.sendMedia) {
        return await outbound.sendMedia(buildContext());
      }
      if (!outbound?.sendText) {
        throw new Error(params.unavailableMessage);
      }
      return await outbound.sendText(buildContext());
    },
  };
}
