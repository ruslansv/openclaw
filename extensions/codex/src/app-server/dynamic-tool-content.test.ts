import { expect, it } from "vitest";
import { convertToolContents } from "./dynamic-tool-content.js";

it.each([false, true])(
  "bounds tool image batches and reports omissions with long text: %s",
  (longText) => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]).toString("base64"),
    };
    const result = convertToolContents(
      [
        {
          type: "text",
          text: `Completed work; image source: saved.png${longText ? "x".repeat(2_000) : ""}`,
        },
        image,
        image,
      ],
      1_000,
    );
    const text = result
      .flatMap((part) =>
        part.type === "inputText" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("");
    expect(text).toContain("Completed work; image source: saved.png");
    expect(result.filter((part) => part.type === "inputImage")).toHaveLength(1);
    expect(text).toContain("narrower");
  },
);
