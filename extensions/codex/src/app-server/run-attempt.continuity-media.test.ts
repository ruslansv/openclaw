import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSolidPngBuffer } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  assistantMessage,
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createResumeHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

describe("Codex attachment continuity", () => {
  it("restores captionless managed documents in order without changing their transcript", async () => {
    const sessionId = "session-continuity-attachments";
    const params = createParams(`agent:main:${sessionId}`, path.join(tempDir, "workspace"));
    await attachSqliteSessionTarget(params, path.join(tempDir, "attachments.sqlite"), sessionId);
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: params.sessionKey!,
      storePath: params.sessionTarget!.storePath!,
    };
    const cutoff = Date.now();
    await writeCodexAppServerBinding(params.sessionFile, {
      threadId: "thread-existing",
      cwd: params.workspaceDir,
      model: params.modelId,
      modelProvider: "openai",
      historyCoveredThrough: new Date(cutoff).toISOString(),
      dynamicToolsFingerprint: "[]",
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
    });
    const tokens = ["CONTINUITY_FILE_BYTES_94d80b", "CONTINUITY_SECOND_FILE_BYTES_153c72"];
    const media = await Promise.all(
      tokens.map(async (token, index) => {
        const saved = await saveMediaBuffer(
          Buffer.from(token),
          "text/plain",
          "inbound",
          undefined,
          `notes-${index}.txt`,
        );
        return {
          url: `media://inbound/${saved.id}`,
          contentType: "text/plain",
          fileName: `notes-${index}.txt`,
          hydrationSuppressed: true,
        };
      }),
    );
    const sourceMessage = {
      role: "user" as const,
      content: "",
      timestamp: cutoff + 1,
      idempotencyKey: "saved-attachment-input:user",
      __openclaw: { media },
    };
    await appendSessionTranscriptMessageByIdentity({
      ...target,
      message: sourceMessage,
      now: cutoff + 1,
    });
    params.prompt = "Continue the saved request.";
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    vi.useFakeTimers();
    const harness = createResumeHarness();
    const run = runCodexAppServerAttempt(params);
    try {
      await run.waitForTurnAccepted();
      await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
      expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
      const request = harness.requests.find((entry) => entry.method === "turn/start");
      const prompt = JSON.stringify(request?.params);
      expect(harness.requests.some((entry) => entry.method === "thread/resume")).toBe(true);
      expect(prompt).toContain(params.prompt);
      for (const token of tokens) {
        expect(prompt).toContain(token);
      }
      expect(prompt.indexOf(tokens[0]!)).toBeLessThan(prompt.indexOf(tokens[1]!));
      const saved = (await readSessionTranscriptEvents(target)).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message?.idempotencyKey === sourceMessage.idempotencyKey ? [message] : [];
      });
      expect(saved).toEqual([sourceMessage]);
    } finally {
      abort.abort("test cleanup");
      await run;
      closeHost();
    }
  });
  it.each(["current", "closed"] as const)(
    "restores real image bytes with exact source ownership (%s)",
    async (mode) => {
      const sessionId = "session-continuity-images";
      const sessionFile = `agent:main:${sessionId}`;
      const storePath = path.join(tempDir, "image-continuity.sqlite");
      const workspaceDir = path.join(tempDir, "image-workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const params = createParams(sessionFile, workspaceDir);
      params.model = { ...params.model, input: ["text", "image"] };
      await attachSqliteSessionTarget(params, storePath, sessionId);
      const target = { agentId: "main", sessionId, sessionKey: params.sessionKey!, storePath };
      const cutoff = Date.now();
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: params.modelId,
        modelProvider: "openai",
        historyCoveredThrough: new Date(cutoff).toISOString(),
        dynamicToolsFingerprint: "[]",
        webSearchThreadConfigFingerprint: JSON.stringify({
          "features.standalone_web_search": false,
          web_search: "disabled",
        }),
      });
      const blue = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
      const green = createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 });
      const image = {
        type: "image" as const,
        mimeType: "image/png",
        data: blue.toString("base64"),
      };
      const saved = await saveMediaBuffer(blue, "image/png", "inbound", undefined, "blue.png");
      const historical = {
        role: "user" as const,
        timestamp: cutoff + 1,
        idempotencyKey: "historical-image:user",
        content: "Read this image.",
        __openclaw: {
          media: [
            { url: `media://inbound/${saved.id}`, contentType: "image/png", fileName: "blue.png" },
          ],
          mediaImageLayout: {
            slots: [{ kind: "offloaded", factIndex: 0 }],
          },
        },
      };
      await appendSessionTranscriptMessageByIdentity({
        ...target,
        message: historical,
        now: cutoff + 1,
      });
      params.prompt = mode === "current" ? "Read this image." : "Can you hear me?";
      if (mode === "current") {
        const currentImage = { ...image, data: green.toString("base64") };
        params.images = [currentImage];
        const current = {
          role: "user" as const,
          timestamp: cutoff + 2,
          idempotencyKey: "current-image:user",
          content: [{ type: "text" as const, text: params.prompt }, currentImage],
        };
        await appendSessionTranscriptMessageByIdentity({
          ...target,
          message: current,
          now: cutoff + 2,
        });
        // Model an already committed current source with no read fence, so both
        // rows enter projection and only exact current-source identity removes it.
        params.userTurnTranscriptRecorder = {
          message: current,
          resolveMessage: async () => current,
          getAdmissionReceipt: () => undefined,
          markRuntimePersistencePending: () => {},
          markRuntimePersisted: () => {},
          markBlocked: () => {},
          hasPersisted: () => true,
          isBlocked: () => false,
          hasRuntimePersistencePending: () => false,
          waitForRuntimePersistence: async () => {},
          persistApproved: async () => undefined,
          persistBlocked: async () => undefined,
          persistFallback: async () => undefined,
        };
      }
      const abort = new AbortController();
      params.abortSignal = abort.signal;
      const started = createDeferred<void>();
      params.onAgentEvent = (event) => {
        if (event.stream === "lifecycle" && event.data.phase === "start") {
          started.resolve();
        }
      };
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      if (mode === "closed") {
        const prepare = params.hostCapabilities.prepareContextMedia!;
        params.hostCapabilities = {
          ...params.hostCapabilities,
          prepareContextMedia: async (request) => {
            const prepared = await prepare(request);
            expect(prepared.images).toHaveLength(1);
            closeHost();
            return prepared;
          },
        };
      }
      vi.useFakeTimers();
      const harness = createResumeHarness();
      const run = runCodexAppServerAttempt(params);
      try {
        if (mode === "closed") {
          await expect(run).rejects.toThrow(/active|closed|authority/i);
          expect(harness.requests.filter((request) => request.method === "turn/start")).toEqual([]);
        } else {
          await started.promise;
          await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
          expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
          const request = harness.requests.find((entry) => entry.method === "turn/start");
          const input = asOptionalRecord(request?.params)?.input;
          expect(Array.isArray(input)).toBe(true);
          expect(input).toEqual([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("<conversation_context>\n[user]\nRead this image."),
            }),
            { type: "image", url: `data:image/png;base64,${blue.toString("base64")}` },
            {
              type: "text",
              text: expect.stringContaining(
                `</conversation_context>\n\nCurrent user request:\n${params.prompt}`,
              ),
              text_elements: [],
            },
            ...(mode === "current"
              ? [{ type: "image", url: `data:image/png;base64,${green.toString("base64")}` }]
              : []),
          ]);
        }
        const rows = (await readSessionTranscriptEvents(target)).flatMap((event) => {
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          return message?.idempotencyKey === historical.idempotencyKey ? [message] : [];
        });
        expect(rows).toEqual([historical]);
      } finally {
        abort.abort("test cleanup");
        await run.catch(() => undefined);
        closeHost();
      }
    },
  );
  it("starts a text continuation without changing saved history or replaying historical pixels", async () => {
    const sessionId = "image-pressure-handoff";
    const params = createParams(`agent:main:${sessionId}`, path.join(tempDir, "workspace"));
    params.agentDir = path.join(tempDir, "agent");
    params.model = { ...params.model, input: ["text", "image"] };
    params.prompt = "Continue from the saved artifact and inspect this new image.";
    const historicalImage = {
      type: "image" as const,
      mimeType: "image/png",
      data: createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 }).toString("base64"),
    };
    const currentImage = {
      ...historicalImage,
      data: createSolidPngBuffer(1, 1, { r: 0, g: 255, b: 0 }).toString("base64"),
    };
    params.images = [currentImage];
    await attachSqliteSessionTarget(params, path.join(tempDir, "history.sqlite"), sessionId);
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: params.sessionKey!,
      storePath: params.sessionTarget!.storePath!,
    };
    const priorMessages = [
      {
        role: "user" as const,
        timestamp: 1,
        content: [{ type: "text" as const, text: "Save the inspected artifact." }, historicalImage],
      },
      {
        ...assistantMessage("", 2),
        content: [
          { type: "toolCall" as const, id: "saved-artifact-call", name: "write", arguments: {} },
        ],
        stopReason: "toolUse" as const,
      },
      {
        role: "toolResult" as const,
        toolCallId: "saved-artifact-call",
        toolName: "write",
        content: [
          {
            type: "text" as const,
            text: "Artifact receipt 74: saved successfully; do not recreate.",
          },
        ],
        isError: false,
        timestamp: 3,
      },
      assistantMessage("The artifact is saved; inspect the next image.", 4),
    ];
    for (const message of priorMessages) {
      await appendSessionTranscriptMessageByIdentity({
        ...target,
        message,
        now: message.timestamp,
      });
    }
    const originalEvents = await readSessionTranscriptEvents(target);
    const rolloutDir = path.join(params.agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    const rolloutPath = path.join(rolloutDir, "rollout-thread-existing.jsonl");
    const rollout =
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "x".repeat(20 * 1024 * 1024) }],
        },
      }) + "\n";
    await fs.writeFile(rolloutPath, rollout);
    await writeCodexAppServerBinding(params.sessionFile, {
      threadId: "thread-existing",
      cwd: params.workspaceDir,
      model: params.modelId,
      modelProvider: "openai",
      rolloutPath,
      historyCoveredThrough: new Date(5).toISOString(),
      dynamicToolsFingerprint: "[]",
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
    });
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    const abort = new AbortController();
    params.abortSignal = abort.signal;
    vi.useFakeTimers();
    const harness = createResumeHarness("thread-existing", async (method) =>
      method === "thread/start" ? threadStartResult() : undefined,
    );
    const run = runCodexAppServerAttempt(params);
    try {
      await run.waitForTurnAccepted();
      const request = harness.requests.find((entry) => entry.method === "turn/start");
      if (!request) {
        throw new Error("Native turn/start request was not observed");
      }
      const { threadId, input } = request.params as {
        threadId: string;
        input: Array<{ type: string; text?: string; url?: string }>;
      };
      await harness.completeTurn({ threadId, turnId: "turn-1" });
      await run;
      expect(harness.requests.some((entry) => entry.method === "thread/start")).toBe(true);
      expect(harness.requests.some((entry) => entry.method === "thread/resume")).toBe(false);
      const text = input.map((part) => part.text ?? "").join("\n");
      expect(text).toContain("Save the inspected artifact.");
      expect(text).toContain("Artifact receipt 74: saved successfully; do not recreate.");
      expect(text).toContain("saved-artifact-call");
      expect(text).toContain("The artifact is saved; inspect the next image.");
      expect(text).toContain(params.prompt);
      expect(input.filter((part) => part.type === "image")).toEqual([
        { type: "image", url: `data:image/png;base64,${currentImage.data}` },
      ]);
      expect((await readSessionTranscriptEvents(target)).slice(0, originalEvents.length)).toEqual(
        originalEvents,
      );
      expect(await fs.readFile(rolloutPath, "utf8")).toBe(rollout);
    } finally {
      abort.abort("test cleanup");
      await run.catch(() => undefined);
      closeHost();
    }
  });
});
