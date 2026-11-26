import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { translate, type Locale } from "../packages/shared/src";
import { WeftClient } from "../tools/visual/weft-client";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 29000);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 49000);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "ignore", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "inherit", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const slug = `phone-${crypto.randomUUID().slice(0, 8)}`;
  const client = new WeftClient(api, web);
  await client.signUp("Phone Layout", `${slug}@example.test`, "a-secure-password");
  const workspace = await client.action("create_workspace", { name: "Phone Layout", slug });
  const project = await client.action("create_project", { workspaceId: workspace.id, name: "Release planning and customer onboarding · การวางแผนรุ่นและการเริ่มใช้งาน", key: "PHONE", visibility: "public" });
  const items: Array<{ id: string; displayId: string; title: string }> = [];
  for (const title of [
    "Prepare the onboarding checklist for customers with multiple locations",
    "ตรวจสอบข้อความภาษาไทยที่มีความยาวบนหน้าจอโทรศัพท์และแท็บเล็ต",
    "Make account settings easier to navigate",
    "ปรับปรุงข้อความแจ้งเตือนและตรวจสอบการแสดงผลในโหมดมืด",
    "Review the support handover and confirm the launch checklist",
    "Confirm the changelog matches the shipped release",
    "ตรวจสอบคู่มือการเริ่มต้นและอัปเดตข้อมูลสำหรับทีมสนับสนุน",
    "Follow up on customer feedback from the pilot release",
  ]) items.push(await client.action("create_work_item", { projectId: project.id, title, priority: items.length % 2 ? "high" : "medium" }));
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  try {
    const path = `/${slug}/projects/PHONE/issues?layout=list`;
    const detailPath = `/${slug}/browse/${items[0]!.displayId}`;
    const go = (page: Page, url: string) => page.goto(web + url, { waitUntil: "commit", timeout: 120_000 });
    const bounds = async (control: Locator) => {
      const box = await control.boundingBox();
      assert.ok(box, `${control} is visible`);
      return box;
    };
    const touchTarget = async (control: Locator) => {
      const box = await bounds(control);
      assert.ok(box.width >= 44 && box.height >= 44, `${control} needs a 44px target, got ${JSON.stringify(box)}`);
      return box;
    };
    const open = async (width: number, height: number, locale: Locale = "en", colorScheme: "light" | "dark" = "light") => {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, isMobile: width < 900, locale, colorScheme, reducedMotion: "reduce" });
      await context.addCookies(client.cookies().map((cookie) => ({ ...cookie, domain: "localhost", path: "/" })));
      await context.addInitScript(({ locale, colorScheme }) => {
        localStorage.setItem("weft.locale", locale);
        localStorage.setItem("weft.theme", colorScheme);
      }, { locale, colorScheme });
      const page = await context.newPage();
      page.setDefaultTimeout(45_000);
      await go(page, path);
      await page.locator("[data-list-row]").first().waitFor({ timeout: 120_000 });
      return page;
    };

    const shots = Bun.env.PHONE_LAYOUT_SHOTS;
    if (shots) {
      await mkdir(shots, { recursive: true });
      for (const locale of ["en", "th"] as const) {
        // The signed-in account preference wins over local storage.
        await client.action("set_my_locale", { locale });
        for (const colorScheme of ["light", "dark"] as const) {
          let phone: Page | undefined;
          for (const [width, height] of [[390, 844], [844, 390], [320, 700], [1440, 900]] as const) {
            const suffix = `${width}x${height}-${locale}-${colorScheme}.png`;
            const listShot = join(shots, `list-${suffix}`);
            const detailShot = join(shots, `detail-${suffix}`);
            if (await Bun.file(listShot).exists() && await Bun.file(detailShot).exists()) continue;
            const desktop = width === 1440;
            const page = desktop || !phone ? await open(width, height, locale, colorScheme) : phone;
            if (!desktop) phone = page;
            if (page.url() !== web + path) {
              await page.setViewportSize({ width, height });
              await go(page, path);
            }
            await page.locator("[data-list-row]").first().waitFor({ timeout: 120_000 });
            await page.locator(`html[lang="${locale}"][data-theme="${colorScheme}"]`).waitFor();
            await page.evaluate(() => document.fonts.ready);
            await page.screenshot({ path: listShot, animations: "disabled" });
            await go(page, detailPath);
            await page.getByRole("heading", { name: items[0]!.title, exact: true }).waitFor();
            await page.getByTestId("description-editor").locator("[contenteditable=true]").waitFor();
            await page.evaluate(() => document.fonts.ready);
            await page.screenshot({ path: detailShot, animations: "disabled" });
            if (desktop) await page.context().close();
          }
          await phone?.context().close();
        }
      }
      await client.action("set_my_locale", { locale: "en" });
    }
    if (!Bun.env.PHONE_LAYOUT_CAPTURE_ONLY) {
      const page = await open(390, 844);
      const main = page.getByRole("main");
      const firstRow = await bounds(page.locator("[data-list-row]").first());
      assert.ok(firstRow.y <= 200, `first list row must start at y ≤ 200, got ${firstRow.y}`);
      console.log(`phone list starts at y=${firstRow.y}`);

      const rows = page.locator("[data-list-row]");
      const heights = await rows.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
      const pitch = Math.max(...heights);
      assert.ok(pitch <= 80, `V4: a two-line phone row is at most 80px, got ${pitch}`);
      assert.ok(pitch - Math.min(...heights) <= 1, `V4: equal rows have equal heights, got ${JSON.stringify(heights)}`);
      const firstItem = page.getByTestId(`row-${items[0]!.displayId}`);
      // V4 keeps 44px targets: every corner of the checkbox and the Priority and State chips answers its own taps.
      for (const [name, control] of [["checkbox", firstItem.getByRole("checkbox")], ["State chip", firstItem.getByRole("button", { name: new RegExp(`^${translate("workItems.state")}:`) })], ["Priority chip", firstItem.getByRole("button", { name: new RegExp(`^${translate("workItems.priority")}:`) })]] as const) {
        const misses = await control.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return [[-21, -21], [21, -21], [-21, 21], [21, 21]].filter(([dx, dy]) => {
            const hit = document.elementFromPoint(box.x + box.width / 2 + dx!, box.y + box.height / 2 + dy!);
            return !(hit && (hit === el || el.contains(hit)));
          });
        });
        assert.deepEqual(misses, [], `V4: ${name} loses taps inside its 44px target`);
      }
      console.log(`V4: phone row height ${pitch}px`);

      const header = main.getByTestId("page-header");
      const back = header.getByRole("link", { name: translate("projects.back") });
      const projectTitle = await bounds(header.getByRole("heading", { level: 1 }));
      const backBox = await touchTarget(back);
      assert.ok(Math.abs(backBox.y + backBox.height / 2 - projectTitle.y - projectTitle.height / 2) < 1);
      assert.equal((await back.innerText()).trim(), "", "V3: back is an icon button on phone");
      assert.equal(backBox.width, 44, "V3: back takes only its 44px target");
      assert.equal(await header.getByRole("button").count(), 0, "V2: the header has no second overflow menu on Work items");
      const overflowTrigger = main.getByRole("button", { name: translate("workItems.moreActions"), exact: true });
      await overflowTrigger.press("Enter");
      await page.getByRole("menu").getByRole("separator").waitFor();
      const settings = page.getByRole("menuitem", { name: translate("projects.settings"), exact: true });
      await touchTarget(settings);
      await settings.press("Enter");
      await page.waitForURL(`**/${slug}/settings/projects/PHONE**`);
      await go(page, path);
      await back.tap();
      await page.waitForURL(`**/${slug}`);
      await go(page, `/${slug}/projects/PHONE/cycles`);
      const headerMenu = header.getByRole("button", { name: translate("projects.settingsTitle") });
      await touchTarget(headerMenu);
      await headerMenu.press("Enter");
      await touchTarget(settings);
      await page.keyboard.press("Escape");
      await go(page, path);
      console.log("project header: icon back by touch; settings in the one overflow menu, and in the header on other project pages");

      const toolbar = main.getByTestId("work-items-toolbar");
      const view = toolbar.getByRole("combobox", { name: translate("layout.switch") });
      const filters = toolbar.getByRole("button", { name: translate("layout.filters") });
      const display = toolbar.getByRole("button", { name: translate("layout.display") });
      const more = toolbar.getByRole("button", { name: translate("workItems.moreActions") });
      const toolbarBoxes = await Promise.all([view, filters, display, more].map(touchTarget));
      assert.ok(toolbarBoxes.every((box) => box.y === toolbarBoxes[0]!.y));
      for (const [layout, testId] of [["board", "board"], ["spreadsheet", "sheet-scroll"], ["calendar", "calendar-layout"], ["gantt", "gantt-layout"], ["list", "work-items-list-container"]]) {
        await view.selectOption(layout!);
        await main.getByTestId(testId!).waitFor();
      }
      await filters.tap();
      const filterPanel = page.getByRole("dialog", { name: translate("layout.filters") });
      await filterPanel.getByRole("button", { name: translate("layout.filter.priority") }).tap();
      await filterPanel.getByRole("checkbox", { name: translate("workItems.priority.high") }).tap();
      await page.keyboard.press("Escape");
      await page.waitForURL((url) => (url.searchParams.get("q") ?? "").includes("high"));
      await go(page, path);
      await display.tap();
      await page.getByRole("dialog", { name: translate("layout.display") }).getByLabel(translate("layout.group")).selectOption("none");
      await page.keyboard.press("Escape");
      await page.waitForURL((url) => url.searchParams.get("group") === "none");
      const overflow = async (name: string, role: "menuitem" | "menuitemcheckbox" = "menuitem") => {
        await more.tap();
        const entry = page.getByRole(role, { name, exact: true });
        await touchTarget(entry);
        await entry.tap();
      };
      await overflow(translate("bulk.selectShown"), "menuitemcheckbox");
      const bulk = main.getByTestId("bulk-bar");
      await bulk.waitFor();
      const floating = main.getByRole("button", { name: translate("workItems.addNew"), exact: true });
      const addBox = await bounds(floating);
      const barBox = await bounds(bulk);
      assert.ok(barBox.y + barBox.height <= addBox.y, `finding 1: the bulk bar ends above the floating Add button, got ${JSON.stringify({ barBox, addBox })}`);
      assert.ok(await floating.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), "finding 1: the floating Add button answers a tap at its centre");
      await bulk.getByRole("button", { name: `${translate("workItems.priority")}: ${translate("workItems.priority")}`, exact: true }).tap();
      await page.getByRole("menuitemradio", { name: translate("workItems.priority.medium"), exact: true }).tap();
      const toast = page.getByTestId("toaster").locator("> div").last();
      await toast.waitFor();
      const toastBox = await bounds(toast);
      assert.ok(toastBox.y + toastBox.height <= addBox.y, `finding 4: a toast stays above the floating Add button, got ${JSON.stringify({ toastBox, addBox })}`);
      await overflow(translate("bulk.selectShown"), "menuitemcheckbox");
      if (await bulk.isVisible()) await overflow(translate("bulk.selectShown"), "menuitemcheckbox");
      await bulk.waitFor({ state: "hidden" });
      await overflow(translate("layout.filterQuery.button"), "menuitemcheckbox");
      await main.getByRole("textbox", { name: translate("layout.filterQuery.label"), exact: true }).fill("priority = high");
      await main.getByRole("button", { name: translate("layout.filterQuery.apply") }).tap();
      await page.waitForURL((url) => url.searchParams.get("q") === "priority = high");
      await overflow(translate("views.saveAs"));
      const save = page.getByRole("dialog", { name: translate("views.form.saveTitle") });
      await save.getByRole("textbox", { name: translate("views.name") }).fill("High priority from phone");
      await save.getByRole("button", { name: translate("views.create"), exact: true }).tap();
      await page.waitForURL(`**/${slug}/projects/PHONE/views/**`);
      console.log("phone toolbar: all five layouts, Filters, Display, Select shown, Query and Save as view");

      await go(page, path);
      const add = main.getByRole("button", { name: translate("workItems.addNew"), exact: true });
      const fab = await touchTarget(add);
      await main.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      assert.ok((await bounds(main)).y + (await bounds(main)).height <= fab.y, "the list scrollport ends above the floating Add button");
      const last = await bounds(page.locator("[data-list-row]").last());
      assert.ok(last.y + last.height <= fab.y, "the last list row sits clear of the floating Add button");
      assert.deepEqual(await bounds(add), fab, "the floating Add button stays fixed while the list scrolls");
      await add.tap();
      const create = page.getByRole("dialog", { name: translate("workItems.modal.title") });
      await create.getByRole("textbox", { name: translate("workItems.titleField"), exact: true }).fill("Created from the phone");
      await create.getByRole("button", { name: translate("workItems.modal.submit"), exact: true }).tap();
      await main.getByRole("link", { name: "Created from the phone", exact: true }).waitFor();
      console.log("floating Add creates a work item and leaves the last row reachable");

      await go(page, detailPath);
      const moreDetail = main.getByRole("button", { name: translate("workItems.more"), exact: true }).first();
      const moreBox = await bounds(moreDetail);
      const iconBox = await bounds(moreDetail.locator("svg"));
      assert.ok(Math.abs(moreBox.x + moreBox.width / 2 - iconBox.x - iconBox.width / 2) <= 1 && Math.abs(moreBox.y + moreBox.height / 2 - iconBox.y - iconBox.height / 2) <= 1, `V1: the detail overflow icon is centred, got ${JSON.stringify({ moreBox, iconBox })}`);
      const actionGroup = main.getByRole("group", { name: translate("workItems.actions") });
      const addDetail = actionGroup.getByRole("button", { name: translate("layout.addShort"), exact: true });
      await touchTarget(addDetail);
      const detailAction = async (name: string) => {
        await addDetail.tap();
        const entry = page.getByRole("menuitem", { name, exact: true });
        await touchTarget(entry);
        return entry;
      };
      await (await detailAction(translate("workItems.addSubItemAction"))).tap();
      await main.getByRole("textbox", { name: `${translate("workItems.subItems")}: ${translate("workItems.titleField")}` }).fill("Phone sub-work item");
      await main.getByRole("button", { name: translate("workItems.subItems.add"), exact: true }).tap();
      await main.getByRole("link", { name: /Phone sub-work item/ }).waitFor();

      for (const [action, title] of [["workItems.addRelationAction", "relations.addTitle"], ["workItems.addLinkAction", "webLinks.addTitle"]] as const) {
        for (const input of ["touch", "keyboard"] as const) {
          const entry = await detailAction(translate(action));
          await (input === "touch" ? entry.tap() : entry.press("Enter"));
          const dialog = page.getByRole("dialog", { name: translate(title) });
          await dialog.waitFor();
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          await addDetail.and(page.locator(":focus")).waitFor({ timeout: 5_000 })
            .catch(async () => assert.fail(`finding 2: focus returns to Add after Escape (${action}, ${input}), got ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`));
        }
      }

      await (await detailAction(translate("workItems.addRelationAction"))).tap();
      const relation = page.getByRole("dialog", { name: translate("relations.addTitle") });
      await relation.getByLabel(translate("relations.target")).selectOption(items[1]!.id);
      await relation.getByRole("button", { name: translate("relations.add"), exact: true }).tap();
      await main.getByRole("link", { name: new RegExp(items[1]!.displayId) }).waitFor();

      // Keyboard only: opening highlights the first action, and the link action is two below it.
      const focused = (name: string) => page.getByRole("menuitem", { name, exact: true, disabled: false }).and(page.locator(":focus"));
      await addDetail.press("Enter");
      await focused(translate("workItems.addSubItemAction")).waitFor();
      await page.keyboard.press("ArrowDown");
      await focused(translate("workItems.addRelationAction")).waitFor();
      await page.keyboard.press("ArrowDown");
      await focused(translate("workItems.addLinkAction")).waitFor();
      await page.keyboard.press("Enter");
      const link = page.getByRole("dialog", { name: translate("webLinks.addTitle") });
      await link.getByLabel(translate("webLinks.urlLabel")).fill("https://example.com/phone");
      await link.getByLabel(translate("webLinks.titleOptional")).fill("Phone reference");
      await link.getByRole("button", { name: translate("webLinks.add"), exact: true }).tap();
      await main.getByRole("link", { name: "Phone reference", exact: true }).waitFor();

      const attachAction = await detailAction(translate("workItems.attachAction"));
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), attachAction.tap()]);
      assert.equal(await chooser.element().getAttribute("data-testid"), "attach-input");
      await main.getByTestId("attachment-dropzone").waitFor();
      console.log("detail Add: creates sub-work item, relation and link, and opens the attachment chooser");

      for (const surface of ["description", "comment"]) {
        const editor = main.getByTestId(`${surface}-editor`).locator("[contenteditable=true]");
        const tools = main.getByTestId(`${surface}-toolbar`);
        await editor.scrollIntoViewIfNeeded();
        const bold = tools.getByRole("button", { name: translate("wiki.tool.bold"), exact: true });
        assert.equal(await bold.evaluate((el) => getComputedStyle(el).opacity), "0");
        const before = await bounds(editor);
        await editor.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
        assert.deepEqual(await bounds(editor), before, `${surface} moves when the toolbar appears`);
        assert.equal(await bold.evaluate((el) => getComputedStyle(el).opacity), "1");
        await touchTarget(bold);
        assert.ok(await tools.evaluate((el) => getComputedStyle(el).flexWrap === "nowrap" && el.scrollWidth > el.clientWidth));
        await bold.tap();
        await page.keyboard.type(`Formatted ${surface}`);
        await editor.locator("strong").getByText(`Formatted ${surface}`, { exact: true }).waitFor();
        const source = tools.getByRole("button", { name: translate("editor.sourceMode"), exact: true });
        await source.focus();
        assert.ok(await tools.evaluate((el) => el.scrollLeft > 0));
        await source.tap();
        await main.getByTestId("editor-source-text").waitFor();
        assert.equal((await source.innerText()).trim(), await source.getAttribute("aria-label"), "finding 3: the visible label is the accessible name in source mode");
        await source.press("Enter");
        await editor.waitFor();
        await main.getByRole("heading", { level: 1 }).click();
        assert.equal(await bold.evaluate((el) => getComputedStyle(el).opacity), "0");
      }
      console.log("description and comment toolbars: one scrollable row, stable focus, formatting and Written form");
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
} finally {
  for (const server of servers) server.kill();
}
