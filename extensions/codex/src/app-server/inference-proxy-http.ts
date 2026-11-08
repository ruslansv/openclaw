import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { rejectWebSocketUpgrade } from "openclaw/plugin-sdk/websocket-runtime";

const OVERLOADED = "Codex inference relay is busy; retry on a fresh connection.";
export const OVERLOAD_HEADERS = { "content-type": "application/json", "retry-after": "1" };
export const OVERLOAD_BODY = JSON.stringify({
  type: "error",
  status: 503,
  // Native treats backend server_is_overloaded as terminal; local saturation must retry.
  error: { type: "server_error", code: "inference_relay_busy", message: OVERLOADED },
  headers: { "retry-after": "1" },
});
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function rejectBusyUpgrade(socket: Duplex) {
  rejectWebSocketUpgrade(socket, {
    status: 503,
    headers: { "Retry-After": "1" },
    body: { contentType: "application/json", text: OVERLOAD_BODY },
  });
}

/** Drain an unfinished upload so its terminal refusal arrives before a TCP reset. */
export function respondToRefusedUpload(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
): void {
  const socket = req.socket;
  const timer = setTimeout(() => socket.destroy(), 1_000);
  timer.unref();
  const cleanup = () => {
    clearTimeout(timer);
    req.off("end", finish);
    socket.off("close", cleanup);
  };
  const finish = () => {
    cleanup();
    socket.end();
  };
  socket.once("close", cleanup);
  res.removeHeader("Connection");
  res.shouldKeepAlive = true;
  res.writeHead(400, { "content-type": "application/json" }).end(body);
  if (req.complete) {
    finish();
  } else {
    req.once("end", finish);
    req.resume();
  }
}

export function relayHeaders(input: IncomingHttpHeaders): Record<string, string> {
  const excluded = new Set(HOP_HEADERS);
  for (const token of (input.connection ?? "").split(",")) {
    excluded.add(token.trim().toLowerCase());
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !excluded.has(key.toLowerCase())) {
      output[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return output;
}
