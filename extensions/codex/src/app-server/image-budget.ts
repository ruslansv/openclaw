import type { ImageContent } from "openclaw/plugin-sdk/llm";

// Leave room below the 32 MiB relay bound for native history, instructions, and tool schemas.
export const CODEX_IMAGE_BATCH_MAX_BYTES = 8 * 1024 * 1024;
export const CODEX_HISTORY_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const CODEX_NATIVE_TRANSCRIPT_DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export function codexInlineImageBytes(image: ImageContent): number {
  return Buffer.byteLength(image.data) + Buffer.byteLength(image.mimeType) + 13;
}
