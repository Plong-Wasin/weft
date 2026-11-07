import { expect, test } from "bun:test";
import { surfaceEditorExtensions } from "../src/editor-extensions";

const undoRedo = (extensions: ReturnType<typeof surfaceEditorExtensions>) => extensions.find((item) => item.name === "starterKit")!.options.undoRedo;

test("description and Comment surfaces keep undo and redo; only the collaborative Wiki editor turns it off", () => {
  expect(undoRedo(surfaceEditorExtensions({ surface: "full" }))).not.toBe(false);
  expect(undoRedo(surfaceEditorExtensions({ surface: "comment" }))).not.toBe(false);
  expect(undoRedo(surfaceEditorExtensions({ surface: "full", collaborative: true }))).toBe(false);
});
