// Layout rules for the workspace surfaces (shadcn-finish ticket 08), on a phone with touch and on desktop, with long Thai and English data.
// One named assertion per class of defect; all are collected so one run lists every failure.
import { launchBrowser, newContext, startApi, startWeb, waitFor } from "./harness";
import type { Page } from "playwright";
import { aiChats, aiMessages, createDatabase, notifications } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { WeftClient, seedWeft } from "../tools/visual/weft-client";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 33180);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 35180);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const env = { ...Bun.env, WEFT_AI_ENABLED: "true", AI_PROVIDER: "openai", AI_MODEL: "gpt-6-luna", OPENAI_API_KEY: "sk-fake" };
const servers = [
  startApi(apiPort, web, { env: { ...env } }),
  startWeb(webPort, { api, env: { ...env, CHOKIDAR_USEPOLLING: "true" } }),
];

const failures: string[] = [];
let checks = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { checks += 1; if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`); };

const shots = ".local/shots/shadcn-finish-08/after";
await Bun.$`mkdir -p ${shots}`.quiet();
const longThai = "โครงการปรับปรุงระบบบริหารจัดการคำสั่งซื้อและการจัดส่งพัสดุระหว่างประเทศสำหรับผู้ขายรายย่อย";
const longEnglish = "Refactor the notification delivery pipeline so that retries back off exponentially";
const longWord = "Supercalifragilisticexpialidocious_identifier_without_any_spaces_at_all";
const longUrl = "https://example.com/a/very/long/url/that/should/never/break/the/layout/of/the/row/under/any/circumstance";

/** Leaf text and controls that stick out of the viewport with no scroll container to reach them. */
const clipped = (page: Page) => page.evaluate(() => {
  const width = document.documentElement.clientWidth;
  return [...document.querySelectorAll<HTMLElement>("main *")].filter((element) => {
    if (element.children.length > 0 && !element.matches("button, input, select, table, pre")) return false;
    const box = element.getBoundingClientRect();
    if (box.width <= 1 || box.right <= width + 1) return false;
    for (let parent = element.parentElement; parent && parent.tagName !== "MAIN"; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowX) && parent.getBoundingClientRect().right <= width + 1) return false;
      if (getComputedStyle(parent).textOverflow === "ellipsis" && parent.getBoundingClientRect().right <= width + 1) return false;
    }
    return true;
  }).slice(0, 4).map((element) => `${element.tagName} ${(element.textContent ?? "").slice(0, 40)} right=${Math.round(element.getBoundingClientRect().right)}`);
});
const squashedIcons = (page: Page) => page.evaluate(() => [...document.querySelectorAll<SVGElement>("button svg")]
  .filter((icon) => { const box = icon.getBoundingClientRect(); return box.height > 0 && box.width < 10; })
  .map((icon) => icon.closest("button")!.getAttribute("aria-label") ?? icon.closest("button")!.textContent));
const shortTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, [role="tab"], [role="checkbox"], [role="switch"]')]
  .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 1 && box.height > 1 && getComputedStyle(element).visibility !== "hidden" && !element.closest('.ProseMirror, [data-slot="editor-toolbar"], [role="toolbar"], [aria-hidden="true"]') && (box.height < 43.5 || box.width < 43.5); })
  .map((element) => { const box = element.getBoundingClientRect(); return `${element.getAttribute("aria-label") ?? element.textContent?.slice(0, 30)} ${Math.round(box.width)}x${Math.round(box.height)}`; }));

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  const seed = await seedWeft(client, slug);
  const cookie = client.cookies().map(({ name, value }) => `${name}=${value}`).join("; ");
  const me = await (await fetch(`${api}/api/me`, { headers: { cookie } })).json() as { user: { id: string }; workspaces: Array<{ id: string }> };
  const workspaceId = me.workspaces[0]!.id;
  const [project] = await client.action<Array<{ id: string }>>("list_projects", { workspaceId });
  await client.action("create_project", { workspaceId, name: longWord, key: "WORD", visibility: "public" });
  await client.action("create_project", { workspaceId, name: longThai.slice(0, 90), key: "THAI", visibility: "private" });
  const item = await client.action<{ id: string }>("create_work_item", { projectId: project!.id, title: `${longEnglish} ${longUrl}` });
  await client.action("submit_intake_item", { projectId: project!.id, title: `${longEnglish} ${longEnglish}`, priority: "urgent" });
  await client.action("create_agent", { workspaceId, name: longWord, model: "gpt-6-luna", instructions: longThai });
  const database = createDatabase();
  await database.db.insert(notifications).values({ workspaceId, userId: me.user.id, actorId: me.user.id, kind: "mention", workItemId: item.id, jobId: crypto.randomUUID() });
  const [chat] = await database.db.insert(aiChats).values({ workspaceId, userId: me.user.id, title: longThai }).returning();
  await database.db.insert(aiMessages).values({ id: crypto.randomUUID(), chatId: chat!.id, role: "user", parts: [{ type: "text", text: longUrl }] });
  await database.db.insert(aiMessages).values({ id: crypto.randomUUID(), chatId: chat!.id, role: "assistant", parts: [{ type: "text", text: `${longThai}\n\n- ${longUrl}\n- ${longWord}${longWord}\n\n| A | B |\n|---|---|\n| ${longEnglish} | ${longEnglish} |\n\n\`\`\`\n${longUrl}${longUrl}\n\`\`\`\n` }] });
  await database.client.end();

  await client.action("create_wiki_page", { workspaceId, title: "Public handbook" });
  const base = `/${slug}`;
  const routes: Record<string, string> = {
    projects: `${base}/projects`, wiki: `${base}/wiki`, wikiPage: `${base}/wiki/${seed.wikiPageId}`, inbox: `${base}/notifications`, intake: `${base}/projects/REF/intake`,
    analytics: `${base}/analytics/overview`, aiChat: `${base}/ai/${chat!.id}`, members: `${base}/settings/members`, agents: `${base}/settings/agents`, audit: `${base}/settings/audit`,
    projectOrder: `${base}/settings/project-order`, general: `${base}/settings`, automation: `${base}/settings/projects/REF/automation`,
    accountNotifications: "/account/notifications", accountSessions: "/account/sessions", accountTokens: "/account/api-tokens",
  };
  const browser = await launchBrowser();
  const open = async (page: Page, path: string) => { await page.goto(`${web}${path}`); await page.locator("main h1, main h2, main li").first().waitFor(); await page.waitForTimeout(700); };

  for (const viewport of [{ width: 390, height: 844, touch: true }, { width: 1440, height: 900, touch: false }]) {
    const context = await newContext(browser, { viewport, hasTouch: viewport.touch, isMobile: viewport.touch, reducedMotion: "reduce" });
    await context.addCookies(client.cookies().map((entry) => ({ ...entry, domain: "localhost", path: "/" })));
    const page = await context.newPage();
    for (const [name, path] of Object.entries(routes)) {
      await open(page, path);
      const where = `${name} at ${viewport.width}`;
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`page does not scroll sideways (${where})`, overflow <= 0, overflow);
      const out = await clipped(page);
      check(`long content stays reachable (${where})`, out.length === 0, out);
      const squashed = await squashedIcons(page);
      check(`button icons keep their size (${where})`, squashed.length === 0, squashed);
      if (viewport.touch) { const short = await shortTargets(page); check(`touch targets are at least 44px (${where})`, short.length === 0, short.slice(0, 8)); }
    }
    await open(page, routes.audit!);
    const selectBorder = await page.locator("main select").first().evaluate((element) => ({ width: getComputedStyle(element).borderTopWidth, height: element.getBoundingClientRect().height }));
    check(`native selects look like controls (${viewport.width})`, selectBorder.width === "1px" && selectBorder.height >= (viewport.touch ? 44 : 36), selectBorder);
    const detailWidth = await page.locator("main table tbody td:last-child").first().evaluate((element) => element.getBoundingClientRect().width);
    check(`audit details column stays readable (${viewport.width})`, detailWidth >= 240, detailWidth);
    await open(page, routes.intake!);
    const title = await page.locator("main button span[title]").first().evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    check(`intake row titles wrap or ellipsize (${viewport.width})`, title.scroll <= title.client + 1, title);
    await open(page, routes.accountNotifications!);
    const gutter = await page.locator("main h1, main h2").first().evaluate((element) => element.getBoundingClientRect());
    check(`account pages keep a page gutter (${viewport.width})`, gutter.x >= 12 && gutter.y >= 12, { x: gutter.x, y: gutter.y });
    await open(page, routes.wiki!);
    const overlap = await page.locator("main table tbody tr").evaluateAll((rows) => rows.filter((row) => [...row.querySelectorAll("td")].some((cell) => cell.scrollWidth > cell.clientWidth + 1 && getComputedStyle(cell).overflowX === "visible")).length);
    check(`wiki table cells do not run into each other (${viewport.width})`, overlap === 0, overlap);
    if (viewport.touch) {
      const access = await page.locator("main table tbody td:nth-child(2) span[title]").evaluateAll((labels) => labels.map((label) => {
        const bounds = label.closest("td")!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(label);
        const fits = label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1
          && Array.from(range.getClientRects()).every((rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.bottom <= bounds.bottom + 1);
        return { text: label.textContent, fits };
      }));
      check("wiki Access label is fully readable on touch", access.length > 0 && access.every((label) => label.fits), access);
      await open(page, routes.general!);
      const box = page.locator('main [data-slot="checkbox"]').first();
      const geometry = await box.evaluate((element) => ({ target: element.getBoundingClientRect().width, painted: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderTopColor, visual: getComputedStyle(element, "::before").width }));
      check("touch checkbox is a 16px box inside a 44px target", geometry.target >= 44 && geometry.visual === "16px" && geometry.border === "rgba(0, 0, 0, 0)", geometry);
    }
    if (viewport.touch) {
      await open(page, routes.projects!);
      await page.getByRole("button", { name: translate("shell.openMenu") }).click();
      const drawer = page.getByRole("dialog");
      await drawer.waitFor();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/drawer-390.png` });
      const names = await drawer.locator("[data-project-toggle] span[title]").evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect().width));
      check("drawer project names keep room to be read", names.length > 0 && names.every((width) => width >= 90), names);
      if (await drawer.locator('[data-project-toggle][aria-expanded="true"]').count() === 0) await drawer.locator("[data-project-toggle]").first().click();
      await drawer.getByRole("link", { name: translate("intake.title"), exact: true }).waitFor();
      await page.screenshot({ path: `${shots}/drawer-390.png` });
      const short = await drawer.locator("button, a[href]").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect()).filter((box) => box.width > 1 && (box.height < 43.5 || box.width < 43.5)).map((box) => `${box.width}x${box.height}`));
      check("drawer controls are at least 44px", short.length === 0, short);
    }
    if (viewport.touch) {
      const collisions = (selector: string) => page.evaluate((selector) => {
        const boxes = [...document.querySelectorAll<HTMLElement>(selector)].map((element) => ({ name: element.getAttribute("aria-label") ?? element.textContent, box: element.getBoundingClientRect(), inner: Math.max(...[...element.querySelectorAll("svg, span:not(.sr-only)")].map((child) => child.getBoundingClientRect().right), element.getBoundingClientRect().right) })).filter(({ box }) => box.width > 1);
        return boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => a.box.left < b.box.right - 1 && b.box.left < a.inner - 1 && a.box.top < b.box.bottom - 1 && b.box.top < a.box.bottom - 1).map((b) => `${a.name} / ${b.name}`));
      }, selector);
      await page.keyboard.press("Escape");
      await open(page, routes.projects!);
      const bar = await collisions("header.h-header button, header.h-header a");
      check("phone top bar controls do not collide", bar.length === 0, bar);
      await page.getByRole("button", { name: translate("shell.openMenu") }).click();
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(400);
      const close = await collisions('[role="dialog"] > button, [role="dialog"] > nav a');
      check("drawer close button does not cover the rail", close.length === 0, close);
    }
    await context.close();
  }
  await browser.close();
  console.log(`${checks - failures.length}/${checks} workspace surface checks passed`);
  if (failures.length) throw new Error(failures.join("\n"));
} finally {
  for (const server of servers) server.kill();
}
