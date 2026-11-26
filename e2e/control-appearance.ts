import type { Locator } from "playwright";

export async function controlAppearance(control: Locator) {
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const pixel = canvas.getContext("2d")!;
    const paints = (color: string) => {
      pixel.clearRect(0, 0, 1, 1);
      pixel.fillStyle = "transparent";
      pixel.fillStyle = color;
      pixel.fillRect(0, 0, 1, 1);
      return pixel.getImageData(0, 0, 1, 1).data[3] > 0;
    };
    const outline = !["none", "hidden"].includes(style.outlineStyle) && parseFloat(style.outlineWidth) > 0 && paints(style.outlineColor)
      ? style.outline : null;
    // Separate the shadow layers without splitting colour-function arguments.
    const rings = style.boxShadow.split(/,(?![^()]*\))/).map((shadow) => shadow.trim()).filter((shadow) => {
      const color = shadow.match(/^[\w-]+\([^)]*\)/)?.[0];
      if (!color || shadow.includes("inset") || !paints(color)) return false;
      const [x, y, blur, spread] = shadow.slice(color.length).trim().split(/\s+/).map(parseFloat);
      return x === 0 && y === 0 && blur === 0 && spread > 0;
    });
    return {
      outline,
      rings,
      backgroundImage: style.backgroundImage,
      borderColor: style.borderTopColor,
      borderVisible: !["none", "hidden"].includes(style.borderTopStyle) && parseFloat(style.borderTopWidth) > 0 && paints(style.borderTopColor),
      backgroundColor: style.backgroundColor,
      color: style.color,
      cursor: style.cursor,
      focusVisible: element.matches(":focus-visible"),
    };
  });
}
