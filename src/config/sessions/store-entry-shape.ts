import { validateSessionId } from "./paths.js";
import type { SessionEntry } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeSessionId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    validateSessionId(value);
    return true;
  } catch {
    return false;
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

function normalizeActivationOnlyEntry(value: Record<string, unknown>): SessionEntry | undefined {
  const groupActivation = normalizeGroupActivation(value.groupActivation);
  if (!groupActivation) {
    return undefined;
  }
  return {
    groupActivation,
    ...(typeof value.groupActivationNeedsSystemIntro === "boolean"
      ? { groupActivationNeedsSystemIntro: value.groupActivationNeedsSystemIntro }
      : {}),
  } as SessionEntry;
}

export function normalizePersistedSessionEntryShape(value: unknown): SessionEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (!isSafeSessionId(value.sessionId)) {
    if (value.sessionId !== undefined) {
      return undefined;
    }
    // WhatsApp group activation backfills can intentionally create a scoped
    // entry before any conversation session exists. Keep only that narrow
    // metadata shape; all other partial entries stay invalid.
    return normalizeActivationOnlyEntry(value);
  }

  let next = value as unknown as SessionEntry;
  const sessionId = value.sessionId.trim();
  if (sessionId !== value.sessionId) {
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
