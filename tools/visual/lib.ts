import { chromium, type Browser } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visualDir } from "./paths";

export const root = join(import.meta.dir, "..", "..");
export const refDir = visualDir();

export type Viewport = { suffix: string; width: number; height: number };
export type Route = { name: string; auth?: boolean; plane: string | null; weft: string | null };
export type RouteFile = { viewports: Viewport[]; routes: Route[] };

export function loadRoutes(path = join(import.meta.dir, "routes.json")): RouteFile {
  return JSON.parse(readFileSync(path, "utf8")) as RouteFile;
}

/** Fills `{placeholder}`s from `values`; returns null when one has no value, so the caller records a missing shot. */
export function fillPath(template: string, values: Record<string, string | number | undefined>): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, key: string) => { const v = values[key]; if (v === undefined) missing = true; return String(v ?? ""); });
  return missing ? null : out;
}

export const launch = (): Promise<Browser> => chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });

const settleCss = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";

export async function shoot(browser: Browser, opts: { url: string; file: string; viewport: Viewport; cookies?: { name: string; value: string; url?: string; domain?: string; path?: string }[]; init?: string }) {
  const context = await browser.newContext({ viewport: { width: opts.viewport.width, height: opts.viewport.height }, colorScheme: "light", reducedMotion: "reduce", locale: "en-US" });
  try {
    if (opts.cookies?.length) await context.addCookies(opts.cookies.map((c) => (c.url ? c : { domain: "localhost", path: "/", ...c })));
    if (opts.init) await context.addInitScript(opts.init);
    const page = await context.newPage();
    await page.goto(opts.url, { waitUntil: "load" });
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
    await page.addStyleTag({ content: settleCss });
    await page.waitForTimeout(700);
    await page.screenshot({ path: opts.file });
  } finally {
    await context.close();
  }
}

/** Counts pixels that differ by more than `tolerance` per channel. Decodes the PNGs inside Chromium, so no image library is needed. */
export async function comparePngs(browser: Browser, a: string, b: string, tolerance = 8): Promise<{ sameSize: boolean; diffPixels: number; total: number; ratio: number }> {
  const page = await browser.newPage();
  try {
    const toDataUrl = async (path: string) => `data:image/png;base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")}`;
    const [da, db] = [await toDataUrl(a), await toDataUrl(b)];
    return await page.evaluate(async ({ da, db, tolerance }) => {
      const load = async (url: string) => { const img = new Image(); img.src = url; await img.decode(); const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const ctx = c.getContext("2d")!; ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, img.width, img.height); };
      const [x, y] = [await load(da), await load(db)];
      if (x.width !== y.width || x.height !== y.height) return { sameSize: false, diffPixels: Math.max(x.width * x.height, y.width * y.height), total: Math.max(x.width * x.height, y.width * y.height), ratio: 1 };
      let diff = 0;
      for (let i = 0; i < x.data.length; i += 4) {
        if (Math.abs(x.data[i]! - y.data[i]!) > tolerance || Math.abs(x.data[i + 1]! - y.data[i + 1]!) > tolerance || Math.abs(x.data[i + 2]! - y.data[i + 2]!) > tolerance) diff += 1;
      }
      const total = x.width * x.height;
      return { sameSize: true, diffPixels: diff, total, ratio: diff / total };
    }, { da, db, tolerance });
  } finally {
    await page.close();
  }
}
