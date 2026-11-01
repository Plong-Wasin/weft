import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RouteFile } from "./lib";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Writes .local/visual/review.html: one row per route and viewport, Plane on the left, Weft on the right, a missing shot flagged. */
export function writeReview(refDir: string, routes: RouteFile): string {
  const has = (dir: string, file: string) => existsSync(join(refDir, dir, file));
  const cell = (dir: string, file: string, label: string) => has(dir, file) ? `<a href="${dir}/${file}" target="_blank"><img loading="lazy" src="${dir}/${file}" alt="${esc(label)}"></a>` : `<div class="missing">Missing ${esc(label)} shot</div>`;
  const rows = routes.routes.flatMap((route) => routes.viewports.map((v) => {
    const file = `${route.name}-${v.suffix}.png`;
    return `<tr><th scope="row">${esc(route.name)}<br><small>${v.width}px</small></th><td>${cell("plane", file, "Plane")}</td><td>${cell("weft", file, "Weft")}</td></tr>`;
  }));
  const external = join(refDir, "external", "sources.json");
  const refs: { file: string; sourceUrl: string; note: string }[] = existsSync(external) ? JSON.parse(readFileSync(external, "utf8")) : [];
  const extRows = refs.map((r) => `<tr><th scope="row">${esc(r.file)}<br><small><a href="${esc(r.sourceUrl)}">source</a></small></th><td colspan="2"><a href="external/${esc(r.file)}" target="_blank"><img loading="lazy" src="external/${esc(r.file)}" alt="${esc(r.note)}"></a><p>${esc(r.note)}</p></td></tr>`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weft vs Plane</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;background:#fafafa;color:#1a1a1a}table{border-collapse:collapse;width:100%;table-layout:fixed}th{width:9rem;text-align:left;vertical-align:top;padding:8px}td{vertical-align:top;padding:8px;border-left:1px solid #ddd}tr{border-top:1px solid #ddd}img{max-width:100%;border:1px solid #ccc;background:#fff}.missing{display:grid;place-items:center;min-height:120px;border:2px dashed #d33;color:#b00;font-weight:600;background:#fff0f0}thead th{position:sticky;top:0;background:#fafafa;z-index:1}</style></head>
<body><h1>Weft vs Plane</h1><p>Plane left, Weft right. Light theme. Generated ${new Date().toISOString()}.</p>
<table><thead><tr><th>Screen</th><th>Plane</th><th>Weft</th></tr></thead><tbody>${rows.join("\n")}${extRows.join("\n")}</tbody></table></body></html>`;
  const out = join(refDir, "review.html");
  writeFileSync(out, html);
  return out;
}
