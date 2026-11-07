import { expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { safeEditorColor, wikiEditorExtensions } from "../src/wiki-editor-extensions";

const schema = getSchema(wikiEditorExtensions);
const hostile = "red; background: url(https://evil.example/x); position: fixed";

test("only hex colours pass the colour guard", () => {
  expect(safeEditorColor("#3B82F6")).toBe("#3b82f6");
  expect(safeEditorColor("#fff")).toBe("#fff");
  for (const value of [hostile, "red", "url(x)", "#12", "#gggggg", null, 5]) expect(safeEditorColor(value)).toBeNull();
});

test("stored colour attributes never reach style output unless they are hex", () => {
  const render = (json: object) => JSON.stringify(schema.nodeFromJSON(json).type.spec.toDOM?.(schema.nodeFromJSON(json)));
  expect(render({ type: "callout", attrs: { color: hostile }, content: [{ type: "paragraph" }] })).not.toContain("evil.example");
  expect(render({ type: "callout", attrs: { color: "#3b82f6" }, content: [{ type: "paragraph" }] })).toContain("#3b82f6");
  const cell = (backgroundColor: string) => render({ type: "tableCell", attrs: { backgroundColor }, content: [{ type: "paragraph" }] });
  expect(cell(hostile)).not.toContain("evil.example");
  expect(cell("#86efac")).toContain("#86efac");
  const mark = (type: string, color: string) => { const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type, attrs: { color } }] }] }] }); const m = doc.firstChild!.firstChild!.marks[0]!; return JSON.stringify(m.type.spec.toDOM?.(m, true)); };
  for (const type of ["textStyle", "highlight"]) {
    expect(mark(type, hostile)).not.toContain("evil.example");
    expect(mark(type, "#ef4444")).toContain("#ef4444");
  }
});
