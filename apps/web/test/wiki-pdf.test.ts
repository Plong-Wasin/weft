import { describe, expect, it } from "bun:test";
import { paperSizePoints } from "../src/wiki-pdf";

describe("Wiki PDF paper sizes", () => {
  it("maps each dialog paper size to its standard PDF dimensions", () => {
    expect(paperSizePoints("a4")).toEqual([595.28, 841.89]);
    expect(paperSizePoints("a3")).toEqual([841.89, 1190.55]);
    expect(paperSizePoints("a2")).toEqual([1190.55, 1683.78]);
    expect(paperSizePoints("letter")).toEqual([612, 792]);
    expect(paperSizePoints("legal")).toEqual([612, 1008]);
    expect(paperSizePoints("tabloid")).toEqual([792, 1224]);
  });
});
