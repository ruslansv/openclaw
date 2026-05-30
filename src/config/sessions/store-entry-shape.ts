import { parseSessionLabel } from "../../sessions/session-label.js";
import { isRecord } from "../../shared/record-coerce.js";
import { validateSessionId } from "./paths.js";
import type { SessionEntry } from "./types.js";

function isSafeSessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255) {
    return false;
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(trimmed);
}

function normalizeTranscriptSessionId(value: string): string | undefined {
  try {
    return validateSessionId(value);
  } catch {
    return undefined;
  }
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeGroupActivation(value: unknown): SessionEntry["groupActivation"] | undefined {
  return value === "mention" || value === "always" ? value : undefined;
}

function normalizeMetadataOnlyEntry(value: Record<string, unknown>): SessionEntry | undefined {
  const next: Partial<SessionEntry> = {};

  const label = parseSessionLabel(value.label);
  if (label.ok) {
    next.label = label.label;
  }

  if (
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    value.updatedAt >= 0
  ) {
    next.updatedAt = value.updatedAt;
  }

  const groupActivation = normalizeGroupActivation(value.groupActivation);
  if (groupActivation) {
    next.groupActivation = groupActivation;
    if (typeof value.groupActivationNeedsSystemIntro === "boolean") {
      next.groupActivationNeedsSystemIntro = value.groupActivationNeedsSystemIntro;
    }
  }

  return Object.keys(next).length > 0 ? (next as SessionEntry) : undefined;
}

export function normalizePersistedSessionEntryShape(value: unknown): SessionEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.sessionId === undefined) {
    // Some routing/session metadata is intentionally created before a
    // transcript id exists. Keep only the narrow safe metadata subset.
    return normalizeMetadataOnlyEntry(value);
  }

  if (!isSafeSessionId(value.sessionId)) {
    return undefined;
  }

  let next = value as unknown as SessionEntry;
  const sessionFile = typeof value.sessionFile === "string" ? value.sessionFile.trim() : undefined;
  const sessionId = value.sessionId.trim();
  const transcriptSessionId = normalizeTranscriptSessionId(sessionId);
  if (!transcriptSessionId && !sessionFile) {
    const metadata = normalizeMetadataOnlyEntry({ ...value, sessionId: undefined });
    if (!metadata) {
      return undefined;
    }
    next = metadata;
  } else if (sessionId !== value.sessionId) {
    next = { ...next, sessionId };
  }

  if (value.sessionFile !== undefined && typeof value.sessionFile !== "string") {
    if (next === value) {
      next = { ...next };
    }
    delete next.sessionFile;
  }

  const updatedAt = normalizeOptionalTimestamp(value.updatedAt);
  if (updatedAt !== value.updatedAt) {
    if (next === value) {
      next = { ...next };
    }
    next.updatedAt = updatedAt ?? 0;
  }

  return next;
}
