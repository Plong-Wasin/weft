// Browser end-to-end flow for the theme, Thai type and auth defects: surfaces separate in dark, the bundled Thai face is
// applied and nothing clips it, utilities that once produced no CSS paint, and the sign-in card reads as one unit.
// Screenshots land in .local/visual/review/theme-type-auth/.
import { chromium, type Browser, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
import { seedWeft, WeftClient } from "../tools/visual/weft-client";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3117);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5217);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("theme-type-auth");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
const sizes = { "1440": { width: 1440, height: 900 }, "390": { width: 390, height: 844 } } as const;
type Size = keyof typeof sizes;

async function open(browser: Browser, size: Size, theme: "light" | "dark", locale: "en" | "th", client?: WeftClient) {
  const context = await browser.newContext({ viewport: sizes[size], colorScheme: theme, reducedMotion: "reduce", locale: locale === "th" ? "th-TH" : "en-US", hasTouch: size === "390" });
  await context.addInitScript(`localStorage.setItem("weft.locale","${locale}");localStorage.setItem("weft.theme","${theme}")`);
  if (client) await context.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));
  const page = await context.newPage();
  const outside: string[] = [];
  page.on("request", (request) => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "localhost") outside.push(request.url()); });
  return { context, page, outside };
}

const background = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor);
const transparent = "rgba(0, 0, 0, 0)";

/** Thai text whose glyphs (tone marks above, vowels below) fall outside the nearest box that clips vertically. */
const clippedThai = (page: Page) => page.evaluate(async () => {
  await document.fonts.ready;
  const canvas = document.createElement("canvas").getContext("2d")!;
  const clipped: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) if (/[ก-๛]/.test(walker.currentNode.textContent ?? "")) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parent = node.parentElement!;
    let box: HTMLElement | null = parent;
    while (box && box !== document.body && !/hidden|clip/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (!box || box === document.body || box.clientHeight <= 1 || !parent.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
    // Boxes that also scroll or hold whole panels clip rows by design; only text-sized boxes can shave a glyph.
    if (box.clientHeight > 80) continue;
    const style = getComputedStyle(parent);
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const glyphs = canvas.measureText(node.textContent!);
    const mark = document.createElement("span");
    mark.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    parent.insertBefore(mark, node);
    const baseline = mark.getBoundingClientRect().bottom;
    mark.remove();
    const rect = box.getBoundingClientRect();
    if (rect.width <= 1) continue;
    const above = rect.top - (baseline - glyphs.actualBoundingBoxAscent);
    const below = baseline + glyphs.actualBoundingBoxDescent - rect.bottom;
    if (above > 1 || below > 1) clipped.push(`${parent.tagName}.${parent.className} "${node.textContent!.slice(0, 30)}" above=${above.toFixed(1)} below=${below.toFixed(1)}`);
  }
  return clipped;
});

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  const seed = await seedWeft(client, slug);
  const [workspace] = (await (await fetch(`${api}/api/me`, { headers: { cookie: client.cookies().map((c) => `${c.name}=${c.value}`).join("; ") } })).json() as { workspaces: { id: string }[] }).workspaces;
  const [project] = await client.action<{ id: string }[]>("list_projects", { workspaceId: workspace!.id });
  const thai = "ปรับปรุงหน้าตั้งค่าที่ผู้ใช้ป้อนข้อมูลปู่ย่า";
  await client.action("create_work_item", { projectId: project!.id, title: thai });
  await client.action("create_label", { projectId: project!.id, name: "ฟีเจอร์ใหม่", color: "#3b82f6" });

  // Auth: one heading and a quiet subtitle, a link-like "Forgot password?", language and theme under the card.
  for (const size of Object.keys(sizes) as Size[]) {
    for (const theme of ["light", "dark"] as const) {
      const { context, page } = await open(browser, size, theme, "en");
      await page.goto(web);
      const heading = page.getByRole("heading", { level: 1 });
      await heading.waitFor();
      check((await heading.innerText()).trim() === translate("app.welcome"), "the h1 holds the title only");
      const subtitle = page.getByText(translate("auth.welcomeBack"));
      const type = async (locator: typeof heading) => locator.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
      check(await type(heading) >= 24 && await type(subtitle) <= 14, "title and subtitle read as two levels");
      const forgot = page.getByRole("button", { name: translate("auth.forgotPassword") });
      await forgot.waitFor();
      check(await forgot.evaluate((element) => { const style = getComputedStyle(element); return style.textDecorationLine === "underline" && (parseFloat(style.borderTopWidth) === 0 || style.borderTopColor === "rgba(0, 0, 0, 0)") && style.boxShadow === "none"; }), "Forgot password is a link, not a second button");
      if (size === "390") check((await forgot.boundingBox())!.height >= 44, "Forgot password keeps a 44px touch target");
      const card = (await page.locator("[data-slot=card]").boundingBox())!;
      const language = (await page.getByRole("combobox", { name: translate("language.label") }).boundingBox())!;
      const gap = language.y - (card.y + card.height);
      check(gap >= 0 && gap <= 32, `language and theme sit under the card, gap ${gap}`);
      if (theme === "dark") check(await background(page, "[data-slot=card]") !== await background(page, "main >> xpath=.."), "dark auth card separates from the page");
      await page.screenshot({ path: `${shots}/sign-in-${size}-${theme}.png` });
      await context.close();
    }
  }

  // Dark surfaces: page, card and border are three different colours, and the shell paints the sidebar role.
  {
    const { context, page } = await open(browser, "1440", "dark", "en", client);
    await page.goto(`${web}/${slug}/settings`);
    await page.locator("[data-slot=card]").first().waitFor();
    const body = await background(page, "body");
    const card = await background(page, "[data-slot=card]");
    const border = await page.locator("[data-slot=card]").first().evaluate((element) => getComputedStyle(element).borderTopColor);
    const rail = (await page.locator(`nav[aria-label="${translate("shell.rail")}"]`).boundingBox())!;
    check(rail.y + rail.height >= sizes["1440"].height - 1, `the rail surface runs to the bottom, ends at ${rail.y + rail.height}`);
    check(new Set([body, card, border]).size === 3, `dark page, card and border differ: ${body} ${card} ${border}`);
    for (const selector of ["header.h-header", `nav[aria-label="${translate("shell.rail")}"]`, `nav[aria-label="${translate("shell.sidebar")}"]`]) {
      const fill = await background(page, selector);
      check(fill !== transparent && fill !== body, `${selector} paints the sidebar surface, got ${fill}`);
    }
    await page.screenshot({ path: `${shots}/settings-1440-dark.png` });
    await context.close();
  }

  // Board "+N": a toggle that keeps focus and says whether the card is open. Wide touch lists: long titles get two lines.
  {
    const labels = await client.action<{ id: string }>("create_label", { projectId: project!.id, name: "Overflow", color: "#ef4444" });
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const me = (await (await fetch(`${api}/api/me`, { headers: { cookie: client.cookies().map((c) => `${c.name}=${c.value}`).join("; ") } })).json() as { user: { id: string } }).user.id;
    const full = await client.action<{ id: string }>("create_work_item", { projectId: project!.id, title: "A deliberately long work item title that cannot possibly fit on one phone line at all", priority: "high", assigneeIds: [me], labelIds: [labels.id], startDate: day(1), dueDate: day(5) });
    await client.action("add_cycle_items", { cycleId: seed.cycleId, workItemIds: [full.id], moveFromCurrentCycle: true });
    await client.action("add_module_items", { moduleId: seed.moduleId, workItemIds: [full.id] });
    const board = await open(browser, "1440", "light", "en", client);
    await board.page.goto(`${web}/${slug}/projects/${seed.key}/issues?layout=board`);
    const more = board.page.getByRole("button", { name: new RegExp(`^${translate("workItems.more")}: `) }).first();
    await more.focus();
    check(await more.getAttribute("aria-expanded") === "false", "+N starts collapsed");
    for (const expanded of ["true", "false"]) {
      await board.page.keyboard.press("Enter");
      check(await more.getAttribute("aria-expanded") === expanded, `+N reports aria-expanded=${expanded}`);
      check(await more.evaluate((element) => element === document.activeElement), "+N keeps focus when it toggles");
    }
    await board.page.screenshot({ path: `${shots}/board-overflow.png` });
    await board.context.close();
    for (const viewport of [{ width: 844, height: 390 }, { width: 980, height: 800 }]) {
      const list = await open(browser, "390", "light", "en", client);
      await list.page.setViewportSize(viewport);
      await list.page.goto(`${web}/${slug}/projects/${seed.key}/issues?layout=list`);
      const title = list.page.getByRole("link", { name: /^A deliberately long work item title/ });
      await title.waitFor();
      const lines = await title.evaluate((element) => Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)));
      check(lines === 2, `long title shows two lines at ${viewport.width}, got ${lines}`);
      await list.page.screenshot({ path: `${shots}/long-title-${viewport.width}.png` });
      await list.context.close();
    }
  }

  // Thai: the bundled face loads from this origin, and no tone mark or lower vowel is shaved off.
  const routes = [
    ["list", `/projects/${seed.key}/issues?layout=list`], ["board", `/projects/${seed.key}/issues?layout=board`], ["spreadsheet", `/projects/${seed.key}/issues?layout=spreadsheet`],
    ["detail", `/browse/${seed.workItem}`], ["settings", "/settings"], ["projects", "/projects"],
  ] as const;
  await client.action("set_my_locale", { locale: "th" });
  for (const size of Object.keys(sizes) as Size[]) {
    const { context, page, outside } = await open(browser, size, "light", "th", client);
    for (const [name, path] of routes) {
      await page.goto(`${web}/${slug}${path}`);
      await page.locator("main").getByText(/[ก-๛]/).first().waitFor({ state: "attached" });
      await page.waitForTimeout(500);
      const clipped = await clippedThai(page);
      check(clipped.length === 0, `Thai clipped on ${name} at ${size}:\n${clipped.join("\n")}`);
      await page.screenshot({ path: `${shots}/th-${name}-${size}.png` });
    }
    check(await page.evaluate(() => [...document.fonts].some((face) => face.family.includes("Weft Thai") && face.status === "loaded")), "the Thai face is loaded");
    check(outside.length === 0, `requests left this origin: ${outside.join(", ")}`);
    if (size === "1440") {
      // The measure itself: a box that is too short for stacked marks must be reported.
      await page.evaluate(() => { const probe = document.createElement("div"); probe.textContent = "ปู่ที่ผู้"; probe.style.cssText = "overflow:hidden;line-height:.8;height:10px;width:200px"; document.body.prepend(probe); });
      check((await clippedThai(page)).length > 0, "the clipping measure reports a clipped probe");
    }
    await context.close();
  }

  console.log("e2e theme-type-auth: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
