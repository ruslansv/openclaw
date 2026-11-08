import { describe, expect, it } from "vitest";
import { buildCodexUserInput } from "./user-input.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

describe("Codex current image admission", () => {
  it("refuses an oversized image batch before creating native input", () => {
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "A".repeat(5 * 1024 * 1024),
    };
    expect(() => buildCodexUserInput("compare these", [image, image])).toThrow(
      "Send fewer or smaller images",
    );
  });

  it("preserves ordinary current images even when historical images are identical", () => {
    const image = { type: "image" as const, mimeType: "image/png", data: PNG_1X1 };
    expect(
      buildCodexUserInput("old\ncurrent", [image], [{ start: 0, end: 4, images: [image] }]),
    ).toEqual([
      { type: "text", text: "old\n", text_elements: [] },
      { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
      { type: "text", text: "current", text_elements: [] },
      { type: "image", url: `data:image/png;base64,${PNG_1X1}` },
    ]);
  });
});
