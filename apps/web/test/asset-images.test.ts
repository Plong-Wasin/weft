import { expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AssetImage } from "../src/asset-images";
import { assetImage } from "../../../packages/actions/src/wiki-editor-extensions";

test("browser and shared schemas declare the same block image attributes", () => {
  const browser = getSchema([StarterKit, AssetImage]).nodes.assetImage!.spec;
  const shared = getSchema([StarterKit, assetImage]).nodes.assetImage!.spec;
  expect(browser.group).toBe("block");
  expect(browser.inline).not.toBe(true);
  expect(browser.group).toBe(shared.group);
  expect(browser.inline).toBe(shared.inline);
  expect(Object.fromEntries(Object.entries(browser.attrs ?? {}).map(([key, attr]) => [key, attr.default]))).toEqual(
    Object.fromEntries(Object.entries(shared.attrs ?? {}).map(([key, attr]) => [key, attr.default])),
  );
  expect(Object.keys(browser.attrs ?? {}).sort()).toEqual(["alignment", "assetId", "width"]);
});
