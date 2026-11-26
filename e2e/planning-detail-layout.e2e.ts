// Browser flow for the work item detail and peek, the create modal's pickers, Cycles, Modules and Views, with long Thai and
// English data at 390px (touch) and 1440px. Each check guards one class of layout defect from the shadcn finish audit:
// content pushed off screen, values spilling out of their control, picker options drawn over each other, controls under 44px
// on touch, oversized checkboxes, row menus dropped to their own line, and names cut to one narrow line.
// Run with `bun e2e/run-all.ts planning-detail-layout` (needs DATABASE_URL, CHROMIUM_PATH).
import { chromium, type Locator, type Page } from "playwright";
import { translate } from "../packages/shared/src";
import { WeftClient, seedWeft } from "../tools/visual/weft-client";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3131);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5231);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
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

const failures: string[] = [];
const check = (condition: boolean, message: string) => { if (!condition) failures.push(message); };
const box = async (locator: Locator) => {
  const found = await locator.first().boundingBox();
  if (!found) throw new Error(`${locator} is not visible`);
  return found;
};

/** Visible elements of the main column that end past the viewport, unless a container that scrolls sideways holds them. */
const offScreen = (page: Page) => page.evaluate(() => {
  const found: string[] = [];
  for (const element of document.querySelectorAll<HTMLElement>("main h1, main h2, main h3, main button, main a, main input, main aside, main li, main p")) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.right <= window.innerWidth + 1) continue;
    let scroller = element.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
    // The page's own scroll container does not count: only a strip inside it (a board, a table, a toolbar).
    if (scroller && scroller.tagName !== "MAIN" && !scroller.querySelector(":scope > section") && scroller.getBoundingClientRect().right <= window.innerWidth + 1) continue;
    found.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 30)}" ends at ${Math.round(rect.right)}`);
  }
  return found.slice(0, 3);
});

/** Controls smaller than 44px in either direction, among those the locator matches. */
const small = (locator: Locator) => locator.evaluateAll((elements) => elements.flatMap((element) => {
  const rect = element.getBoundingClientRect();
  return !rect.height || (rect.height >= 43.5 && rect.width >= 43.5) ? [] : [`"${(element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 24)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`];
}));

/** Options whose content is taller than their own box, so it is drawn over the next one. */
const spilling = (locator: Locator) => locator.evaluateAll((elements) => elements.filter((element) => element.scrollHeight > element.clientHeight + 1).map((element) => (element.textContent ?? "").slice(0, 40)));

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  const seed = await seedWeft(client, slug);
  const cookie = client.cookies().map((c) => `${c.name}=${c.value}`).join("; ");
  const me = await (await fetch(`${api}/api/me`, { headers: { cookie } })).json() as any;
  const longMember = "Alexandria Catherine Montgomery-Worthington, International Delivery Operations";
  const rename = await fetch(`${api}/api/auth/update-user`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: web, cookie },
    body: JSON.stringify({ name: longMember }),
  });
  if (!rename.ok) throw new Error(`Could not seed long member name: ${rename.status}`);
  const [project] = await client.action("list_projects", { workspaceId: me.workspaces[0].id });
  const longTh = "รอบการพัฒนาไตรมาสที่สี่ปรับปรุงประสบการณ์ผู้ใช้และความเสถียรของแอปบนมือถือ";
  const longName = `${longTh} and mobile sprint`;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const cycle = await client.action("create_cycle", { projectId: project.id, name: longName, startDate: day(20), endDate: day(34) });
  const module = await client.action("create_module", { projectId: project.id, name: longName, leadId: me.user.id, status: "in-progress", startDate: day(-3), endDate: day(30), descriptionMarkdown: `${longTh}\n\nhttps://example.com/${"x".repeat(90)}` });
  await client.action("add_module_items", { moduleId: module.id, workItemIds: [seed.workItemId] });
  if (seed.moduleId) await client.action("add_module_items", { moduleId: seed.moduleId, workItemIds: [seed.workItemId] });
  const view = await client.action("create_view", { projectId: project.id, name: longName, description: longName, query: "priority = high", layout: "list" });
  const labels = [];
  for (const name of ["ฟีเจอร์ใหม่ที่ลูกค้าร้องขอเข้ามาบ่อยมาก", "A very long label name that keeps going on", "Backend"]) labels.push(await client.action("create_label", { projectId: project.id, name }));
  await client.action("update_work_item", { workItemId: seed.workItemId, labelIds: labels.map((label) => label.id) });
  await client.action("create_web_link", { workItemId: seed.workItemId, url: "https://example.com/spec", title: longName });

  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const root = `/${slug}/projects/REF`;
  for (const width of [390, 1440]) {
    const phone = width === 390;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
    await context.addCookies(client.cookies().map((c) => ({ ...c, domain: "localhost", path: "/" })));
    const page = await context.newPage();
    const open = async (path: string) => {
      await page.goto(`${web}${path}`, { waitUntil: "load" });
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
    };
    const touch = async (screen: string, locator: Locator) => {
      if (!phone) return;
      const found = await small(locator);
      check(found.length === 0, `${screen}: controls under 44px on touch: ${found.slice(0, 6).join(", ")}`);
    };
    const onScreen = async (screen: string) => {
      const found = await offScreen(page);
      check(found.length === 0, `${screen} at ${width}px runs off screen: ${found.join("; ")}`);
    };

    // Work item detail.
    await open(`/${slug}/browse/${seed.workItem}`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await onScreen("detail");
    if (!phone) {
      const value = page.locator("aside [data-property-row] button").filter({ hasText: "Backend" }).first();
      await value.waitFor();
      check(await value.evaluate((element) => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1), "detail: the Labels value spills out of its control");
    }
    if (!phone) {
      const modulesValue = page.locator("aside").getByRole("button", { name: new RegExp(`^${translate("workItems.modules")}:`) });
      check(await modulesValue.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "detail: the Modules value spills out of its control");
    }
    await touch("detail editor toolbar", page.getByTestId("description-toolbar").locator("button"));
    await touch("detail timeline", page.locator("main select"));
    await touch("detail links", page.getByRole("button", { name: new RegExp(`^(${translate("webLinks.copy")}|${translate("webLinks.edit")}|${translate("webLinks.remove")})$`) }));
    if (phone) {
      const crumbs = (await page.getByRole("navigation", { name: translate("workItems.breadcrumb") }).innerText()).trim();
      check(!crumbs.startsWith("›"), `detail: the phone breadcrumb starts with a separator: ${crumbs}`);
    }

    await touch("detail actions", page.getByRole("button", { name: new RegExp(`^(${translate("workItems.addSubItemAction")}|${translate("workItems.addRelationAction")}|${translate("workItems.addLinkAction")}|${translate("workItems.attachAction")})$`) }));
    await touch("detail property sections", page.locator("main [data-props-section] h3 button"));

    // Peek.
    await open(`${root}/issues?layout=list&peek=${seed.workItem}`);
    await page.getByRole("link", { name: translate("workItems.peek.expand") }).waitFor();
    await touch("peek header", page.getByRole("link", { name: translate("workItems.peek.expand") }));
    await touch("peek header", page.getByRole("button", { name: translate("workItems.peek.close") }));
    if (phone) check((await box(page.getByRole("link", { name: translate("workItems.peek.expand") }))).height <= 48, "peek at 390px: the Open full page label wraps");
    await touch("peek footer", page.locator("[data-peek-actions] button"));

    // Create modal pickers: a long option takes the height it needs.
    await open(`${root}/issues?layout=list`);
    await page.getByRole("button", { name: translate("workItems.addNew"), exact: true }).first().click();
    const modal = page.locator("[data-create-modal]");
    for (const label of [translate("workItems.cycle"), translate("workItems.modules")]) {
      await modal.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
      const options = page.locator("[role=menuitemradio], [role=menuitemcheckbox]");
      await options.first().waitFor();
      const found = await spilling(options);
      check(found.length === 0, `create modal ${label} picker at ${width}px: options overflow their row: ${found.join(", ")}`);
      await page.keyboard.press("Escape");
    }

    // Cycles list: the menu stays on the name's line and the archived checkbox is a checkbox, not a 44px square.
    await open(`${root}/cycles`);
    const row = page.getByTestId("cycle-row").first();
    await row.waitFor();
    await onScreen("cycles");
    const name = await box(row.getByRole("link"));
    const menu = await box(row.getByRole("button", { name: translate("cycles.menu") }));
    check(menu.y < name.y + name.height && name.y < menu.y + menu.height, `cycles at ${width}px: the row menu is not on the name's line`);
    const checkbox = await box(page.getByRole("checkbox", { name: translate("cycles.showArchived") }));
    check(checkbox.width <= 20, `cycles at ${width}px: the Show archived box is drawn ${checkbox.width}px wide`);
    await touch("cycles", page.getByRole("button", { name: translate("cycles.new") }));

    await open(`${root}/cycles/${cycle.id}`);
    await page.getByRole("heading", { name: longName }).waitFor();
    await onScreen("cycle detail");

    // Modules list and detail.
    await open(`${root}/modules`);
    await page.getByTestId(`module-row-${longName}`).waitFor();
    await onScreen("modules");
    const filters = page.getByTestId("module-filters");
    const from = await box(filters.locator("label").filter({ hasText: translate("modules.dateFrom") }));
    const to = await box(filters.locator("label").filter({ hasText: new RegExp(`^${translate("modules.dateTo")}`) }));
    check(Math.abs(from.y - to.y) < 4, `modules at ${width}px: the date filters stack instead of sharing a row`);
    const nameBox = await box(page.getByTestId(`module-row-${longName}`).getByRole("link"));
    check(nameBox.width >= (phone ? 200 : 300), `modules at ${width}px: the long name is only ${nameBox.width}px wide`);
    await touch("modules header", page.getByRole("button", { name: new RegExp(`^(${translate("modules.display.list")}|${translate("modules.display.grid")}|${translate("modules.addNew")})$`) }));

    const lead = filters.getByRole("combobox", { name: translate("modules.leadFilter") });
    await lead.click();
    await page.getByRole("option", { name: longMember, exact: true }).click();
    const leadFits = await lead.evaluate((trigger, name) => {
      const value = trigger.querySelector<HTMLElement>("[data-slot=select-value]")!;
      const chevron = trigger.querySelector("svg")!.getBoundingClientRect();
      const bounds = trigger.getBoundingClientRect();
      return value.textContent === name && getComputedStyle(value).textOverflow === "ellipsis"
        && value.getBoundingClientRect().right <= chevron.left
        && chevron.width >= 15 && chevron.right <= bounds.right;
    }, longMember);
    check(leadFits, `Module Lead filter at ${width}px: long selected name ellipsizes and leaves the chevron inside the trigger`);

    await open(`${root}/modules/${module.id}`);
    const panel = page.locator("#module-details-panel");
    await panel.getByTestId("module-items-count").waitFor();
    await onScreen("module detail");
    check(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), `module detail at ${width}px: the properties panel content is wider than the panel`);
    const status = await box(panel.getByRole("button", { name: new RegExp(`^${translate("modules.status")}:`) }));
    const risks = await box(panel.getByRole("region", { name: translate("modules.risks") }));
    check(status.y < risks.y, "module detail: the properties come after the risk breakdown");
    const itemRow = page.getByTestId(`row-${seed.workItem}`);
    check(await itemRow.getByRole("button", { name: translate("modules.remove"), exact: true }).count() === 0, "module detail: removal must sit in the row menu");
    const rowAction = itemRow.getByRole("button", { name: new RegExp(`^${translate("modules.actions")}: ${seed.workItem}`) });
    check(await rowAction.count() === 1, "module detail: the row has no actions menu");
    if (!phone) {
      const row = await box(itemRow);
      const action = await box(rowAction);
      const title = await box(itemRow.getByRole("link", { name: "Set up CI pipeline" }));
      const labels = await box(itemRow.getByRole("button", { name: new RegExp(`^${translate("workItems.labels")}:`) }));
      check(row.x + row.width - action.x - action.width <= 24 && title.width >= 112 && labels.x >= title.x + title.width,
        "Module detail List: the menu sits at the row edge and leaves space for the title and Labels");
    }

    // Views list and detail.
    await open(`${root}/views`);
    const viewLink = page.getByTestId(`view-row-${longName}`).getByRole("link");
    await viewLink.waitFor();
    await onScreen("views");
    if (phone) check((await box(viewLink)).height >= 36, "views at 390px: a long View name is cut to one line");
    await touch("views", page.getByRole("button", { name: translate("views.add") }));

    await open(`${root}/views/${view.id}`);
    const heading = page.getByRole("heading", { name: longName });
    await heading.waitFor();
    await onScreen("view detail");
    if (phone) check((await box(heading)).width >= 250, `view detail at 390px: the title is squeezed to ${(await box(heading)).width}px`);
    await context.close();
  }
  await browser.close();
} catch (error) {
  failures.push(String(error));
} finally {
  for (const server of servers) server.kill();
}
if (failures.length) console.error(failures.join("\n"));
else console.log("planning-detail-layout e2e ok");
process.exit(failures.length ? 1 : 0);
