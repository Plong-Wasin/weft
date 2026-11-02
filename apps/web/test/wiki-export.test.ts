import { describe, expect, it } from "bun:test";
import { toMarkdown } from "../src/wiki-export";

describe("wiki page Markdown export", () => {
  it("round-trips headings, lists, task lists, tables, code, and linked images", async () => {
    const markdown = await toMarkdown({ type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] }] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Name" }] }] }] }, { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Ada" }] }] }] }] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const x = 1;" }] },
      { type: "assetImage", attrs: { assetId: "asset-1" } },
    ] }, async (id) => `https://assets.example/${id}`);
    expect(markdown).toBe("## Plan\n\n- One\n\n- [x] Done\n\n| Name |\n| --- |\n| Ada |\n\n```ts\nconst x = 1;\n```\n\n![Image](https://assets.example/asset-1)");
  });
});
