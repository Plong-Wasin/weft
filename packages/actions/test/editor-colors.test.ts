import { expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { createWikiLowlight, safeEditorColor, wikiEditorExtensions } from "../src/wiki-editor-extensions";
import { writtenFormAttributePolicy } from "../src/written-form";

const schema = getSchema(wikiEditorExtensions);
const hostile = "red; background: url(https://evil.example/x); position: fixed";

test("hex and named basic colours pass the colour guard", () => {
  expect(safeEditorColor("#3B82F6")).toBe("#3b82f6");
  expect(safeEditorColor("#fff")).toBe("#fff");
  for (const value of ["red", "orange", "yellow", "green", "blue", "purple", "gray", "black", "white"]) expect(safeEditorColor(value)).toBe(value);
  for (const value of [hostile, "url(x)", "#12", "#gggggg", null, 5]) expect(safeEditorColor(value)).toBeNull();
});

test("stored colour attributes reach style output only when allowlisted", () => {
  const render = (json: object) => JSON.stringify(schema.nodeFromJSON(json).type.spec.toDOM?.(schema.nodeFromJSON(json)));
  expect(render({ type: "callout", attrs: { color: hostile }, content: [{ type: "paragraph" }] })).not.toContain("evil.example");
  expect(render({ type: "callout", attrs: { color: "#3b82f6" }, content: [{ type: "paragraph" }] })).toContain("#3b82f6");
  expect(render({ type: "callout", attrs: { color: "purple" }, content: [{ type: "paragraph" }] })).toContain("purple");
  const cell = schema.nodeFromJSON({ type: "tableCell", attrs: { backgroundColor: hostile }, content: [{ type: "paragraph" }] });
  expect(JSON.stringify(cell.toJSON())).toContain("backgroundColor");
  expect(JSON.stringify(cell.type.spec.toDOM?.(cell))).not.toContain("evil.example");
  const mark = (type: string, color: string) => { const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type, attrs: { color } }] }] }] }); const m = doc.firstChild!.firstChild!.marks[0]!; return JSON.stringify(m.type.spec.toDOM?.(m, true)); };
  for (const type of ["textStyle", "highlight"]) {
    expect(mark(type, hostile)).not.toContain("evil.example");
    expect(mark(type, "#ef4444")).toContain("#ef4444");
  }
});

test("the editor retains legacy attrs for Yjs and marks them non-persisted in Written form", () => {
  expect(schema.nodes.paragraph!.spec.attrs).toHaveProperty("textAlign");
  expect(schema.nodes.heading!.spec.attrs).toHaveProperty("textAlign");
  expect(schema.nodes.tableCell!.spec.attrs).toHaveProperty("backgroundColor");
  expect(schema.nodes.tableHeader!.spec.attrs).toHaveProperty("backgroundColor");
  expect(writtenFormAttributePolicy["node:paragraph.textAlign"]).toMatchObject({ persisted: false });
  expect(writtenFormAttributePolicy["node:tableCell.backgroundColor"]).toMatchObject({ persisted: false });
  for (const mark of ["textStyle", "highlight", "underline", "subscript", "superscript"]) expect(schema.marks[mark]).toBeDefined();
});

test("diff code blocks mark removed and added lines while keeping their leading signs", () => {
  const highlighted = JSON.stringify(createWikiLowlight().highlight("diff", "-old line\n+new line"));
  expect(highlighted).toContain("deletion");
  expect(highlighted).toContain("-old line");
  expect(highlighted).toContain("addition");
  expect(highlighted).toContain("+new line");
});
