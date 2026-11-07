import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

export type WikiPaperSize = "a4" | "a3" | "a2" | "letter" | "legal" | "tabloid";

const paperSizes: Record<WikiPaperSize, [number, number]> = {
  a4: [595.28, 841.89],
  a3: [841.89, 1190.55],
  a2: [1190.55, 1683.78],
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
};

export function paperSizePoints(size: WikiPaperSize): [number, number] {
  return [...paperSizes[size]];
}

/** Render the visible rich text as a paginated PDF in the browser. */
export async function renderWikiPdf(source: HTMLElement, title: string, size: WikiPaperSize, includeImages: boolean): Promise<Blob> {
  const [pageWidth, pageHeight] = paperSizePoints(size);
  const margin = 36;
  const contentWidth = pageWidth - margin * 2;
  const cssWidth = contentWidth * 96 / 72;
  const capture = document.createElement("article");
  capture.style.cssText = `position:fixed;left:-100000px;top:0;width:${cssWidth}px;box-sizing:border-box;padding:0;background:#fff;color:#111;font:16px/1.55 Arial,sans-serif`;
  const heading = document.createElement("h1");
  heading.textContent = title;
  heading.style.cssText = "font-size:28px;line-height:1.2;margin:0 0 24px;font-weight:700";
  capture.append(heading);
  const editor = source.querySelector<HTMLElement>(".ProseMirror");
  if (!editor) throw new Error("Wiki page content is unavailable");
  const content = editor.cloneNode(true) as HTMLElement;
  content.className = "";
  content.style.cssText = "min-height:0;white-space:normal";
  for (const element of [content, ...content.querySelectorAll<HTMLElement>("*")]) {
    element.removeAttribute("class");
    element.style.setProperty("color", "#111", "important");
    element.style.setProperty("background-color", "transparent", "important");
    element.style.setProperty("border-color", "#d1d5db", "important");
    element.style.setProperty("box-shadow", "none", "important");
  }
  content.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((node) => { (node as HTMLElement).style.cssText += ";font-weight:700;line-height:1.25;margin:1em 0 .5em"; });
  content.querySelectorAll("p").forEach((node) => { (node as HTMLElement).style.cssText += ";margin:.6em 0"; });
  content.querySelectorAll("ul,ol").forEach((node) => { (node as HTMLElement).style.cssText += ";padding-left:1.5em;margin:.6em 0"; });
  content.querySelectorAll("table").forEach((node) => { (node as HTMLElement).style.cssText += ";border-collapse:collapse;width:100%;margin:.8em 0"; });
  content.querySelectorAll("th,td").forEach((node) => { (node as HTMLElement).style.cssText += ";border:1px solid #9ca3af;padding:6px;text-align:left"; });
  content.querySelectorAll("pre").forEach((node) => { (node as HTMLElement).style.cssText += ";background:#f3f4f6;padding:10px;white-space:pre-wrap"; });
  content.querySelectorAll("code").forEach((node) => { (node as HTMLElement).style.cssText += ";font-family:monospace"; });
  content.querySelectorAll("aside").forEach((node) => { (node as HTMLElement).style.cssText += ";border-left:3px solid #9ca3af;padding:8px 12px;margin:.8em 0"; });
  capture.append(content);
  if (!includeImages) capture.querySelectorAll("img").forEach((image) => image.remove());
  document.body.append(capture);
  try {
    const canvas = await html2canvas(capture, {
      scale: 2, useCORS: true, backgroundColor: "#fff", windowWidth: Math.ceil(cssWidth),
      onclone: (clonedDocument) => {
        for (const root of [clonedDocument.documentElement, clonedDocument.body]) {
          root.style.setProperty("background-color", "#fff", "important");
          root.style.setProperty("color", "#111", "important");
        }
      },
    });
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: [pageWidth, pageHeight], compress: true });
    const imageWidth = contentWidth;
    const pageContentHeight = pageHeight - margin * 2;
    const sliceHeight = Math.floor(pageContentHeight * canvas.width / imageWidth);
    for (let offset = 0; offset < canvas.height; offset += sliceHeight) {
      if (offset > 0) pdf.addPage([pageWidth, pageHeight], "portrait");
      const height = Math.min(sliceHeight, canvas.height - offset);
      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = height;
      const context = slice.getContext("2d");
      if (!context) throw new Error("Could not render Wiki page");
      context.drawImage(canvas, 0, offset, canvas.width, height, 0, 0, canvas.width, height);
      const drawnHeight = height * imageWidth / canvas.width;
      pdf.addImage(slice.toDataURL("image/png"), "PNG", margin, margin, imageWidth, drawnHeight, undefined, "FAST");
    }
    return pdf.output("blob");
  } finally {
    capture.remove();
  }
}
