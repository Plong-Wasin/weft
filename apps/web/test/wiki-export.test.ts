import { describe, expect, it } from "bun:test";
import { richTextInput } from "../../../packages/actions/src/rich-markdown";
import { pageMarkdown, readableReferenceLabels, splitPageMarkdown, toMarkdown } from "../src/wiki-export";

describe("wiki page Markdown export", () => {
  it("exports the saved Written form without losing readable stable references", () => {
    expect(pageMarkdown("Launch plan", "[[MOB-231|work-item:01234567-89ab-cdef-0123-456789abcdef]]\n\n@{Ada Lovelace|member-1}")).toBe(
      "<!-- weft:page-title=Launch%20plan -->\n# Launch plan\n\n[[MOB-231|work-item:01234567-89ab-cdef-0123-456789abcdef]]\n\n@{Ada Lovelace|member-1}",
    );
  });
  it("adds a readable title and Work item key while preserving the reference id", async () => {
    const result = await readableReferenceLabels(
      "[[MOB-231|work-item:01234567-89ab-cdef-0123-456789abcdef]] [[Handbook|page:11234567-89ab-cdef-0123-456789abcdef]] @{Ada|member-1}",
      async (kind, id, label) => kind === "work-item" ? `${label === "MOB-231" ? "Release plan" : label} (MOB-231)` : `Team ${label}`,
    );
    expect(result).toBe("[[Release plan (MOB-231)|work-item:01234567-89ab-cdef-0123-456789abcdef]] [[Team Handbook|page:11234567-89ab-cdef-0123-456789abcdef]] @{Ada|member-1}");
  });
  it("imports the downloaded file with the same person, Work item, and page ids", async () => {
    const workItemId = "01234567-89ab-cdef-0123-456789abcdef";
    const pageId = "11234567-89ab-cdef-0123-456789abcdef";
    const source = `@{Ada Lovelace|member-1} [[MOB-231|work-item:${workItemId}]] [[Handbook|page:${pageId}]]`;
    const labels = await readableReferenceLabels(source, async (kind, _id, label) => kind === "work-item" ? `Release plan (${label})` : `Team ${label}`);
    const file = pageMarkdown("Launch plan", labels);
    const imported = richTextInput(undefined, splitPageMarkdown("Launch plan.md", file).contentMarkdown, "content", "contentMarkdown") as any;
    const ids: string[] = [];
    const visit = (node: any) => {
      if (node.type === "mention") ids.push(node.attrs.id);
      for (const mark of node.marks ?? []) if (mark.type === "link") ids.push(mark.attrs.targetId);
      for (const child of node.content ?? []) visit(child);
    };
    visit(imported);
    expect(ids).toEqual(["member-1", workItemId, pageId]);
    expect(labels).toContain("Release plan (MOB-231)");
  });
  it("recognizes the exported title heading when a file is imported again", () => {
    expect(splitPageMarkdown("Launch plan.md", pageMarkdown("Launch plan", "## Steps\n\n- one"))).toEqual({ title: "Launch plan", contentMarkdown: "## Steps\n\n- one" });
  });
  it("does not discard an ordinary first heading just because it matches the file name", () => {
    expect(splitPageMarkdown("Launch plan.md", "# Launch plan\n\n## Notes")).toEqual({ title: "Launch plan", contentMarkdown: "# Launch plan\n\n## Notes" });
  });
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
