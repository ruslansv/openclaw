// Store entry shape normalization rejects unsafe persisted metadata before runtime use.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseSessionLabel } from "../../sessions/session-label.js";
import { validateSessionId } from "./paths.js";
import type { SessionEntry, SessionGoal } from "./types.js";

// Persisted stores may contain old or malformed ids; reject path-like ids before use.
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

function normalizeOptionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
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

  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheRead",
    "cacheWrite",
    "estimatedCostUsd",
    "contextTokens",
  ] as const) {
    const normalized = normalizeOptionalNonNegativeNumber(value[key]);
    if (normalized !== undefined) {
      next[key] = normalized;
    }
  }

  if (typeof value.totalTokensFresh === "boolean") {
    next.totalTokensFresh = value.totalTokensFresh;
  }

  if (isRecord(value.goal)) {
    next.goal = value.goal as SessionGoal;
  }

  const lastChannel = normalizeOptionalTrimmedString(value.lastChannel);
  if (lastChannel) {
    next.lastChannel = lastChannel as SessionEntry["lastChannel"];
  }
  const lastTo = normalizeOptionalTrimmedString(value.lastTo);
  if (lastTo) {
    next.lastTo = lastTo;
  }
  const lastAccountId = normalizeOptionalTrimmedString(value.lastAccountId);
  if (lastAccountId) {
    next.lastAccountId = lastAccountId;
  }
  const lastThreadId =
    normalizeOptionalTrimmedString(value.lastThreadId) ??
    (typeof value.lastThreadId === "number" && Number.isFinite(value.lastThreadId)
      ? value.lastThreadId
      : undefined);
  if (lastThreadId !== undefined) {
    next.lastThreadId = lastThreadId;
  }

  return Object.keys(next).length > 0 ? (next as SessionEntry) : undefined;
}

function normalizeSessionlessLockedEntry(value: Record<string, unknown>): SessionEntry {
  const next: SessionEntry = {
    ...(normalizeMetadataOnlyEntry(value) ?? {}),
    modelSelectionLocked: true,
  };
  const agentHarnessId = normalizeOptionalTrimmedString(value.agentHarnessId);
  if (agentHarnessId) {
    next.agentHarnessId = agentHarnessId;
  }
  if (typeof value.modelProvider === "string") {
    next.modelProvider = value.modelProvider;
  }
  if (typeof value.model === "string") {
    next.model = value.model;
  }
  return next;
}

/** Normalizes persisted session store entries before they reach runtime callers. */
export function normalizePersistedSessionEntryShape(value: unknown): SessionEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const modelSelectionLocked = value.modelSelectionLocked === true;
  let next = value as unknown as SessionEntry;
  const sessionFile = typeof value.sessionFile === "string" ? value.sessionFile.trim() : undefined;

  if (value.sessionId === undefined) {
    if (modelSelectionLocked) {
      // Keep lock-bearing rows lock-bearing so store-level invariant checks can
      // reject reserved or harness-owned rows instead of normalizing them away.
      return normalizeSessionlessLockedEntry(value);
    }
    // Routing metadata can be created before a transcript id exists; preserve
    // the safe subset instead of dropping useful delivery/session state.
    return normalizeMetadataOnlyEntry(value);
  }

  if (!isSafeSessionId(value.sessionId)) {
    return undefined;
  }

  const sessionId = value.sessionId.trim();
  if (modelSelectionLocked && sessionId !== value.sessionId) {
    // A harness lock protects the exact durable identity. Repairing it here
    // would make a corrupted row look valid before ownership validation.
    return undefined;
  }

  const transcriptSessionId = normalizeTranscriptSessionId(sessionId);
  if (!transcriptSessionId && !sessionFile) {
    if (modelSelectionLocked) {
      return undefined;
    }
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
