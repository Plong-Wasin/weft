// Browser end-to-end flow: the command palette (Ctrl+K / Cmd+K), its search and commands, focus return, the shortcuts page, and the phone layout.
// Run with `bun e2e/command-palette.e2e.ts` (needs the shared weft-postgres container; set DATABASE_URL to use your own database). Screenshots go to .local/visual/review/35-command-palette.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { resources, translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31037);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52037);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("35-command-palette");
const acceptanceShotPhase = Bun.env.SHADCN_SCREENSHOT_PHASE ?? "after";
const acceptanceShots = join(process.cwd(), ".local/shots/shadcn-05", acceptanceShotPhase);
mkdirSync(acceptanceShots, { recursive: true });
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

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const palette = () => page.getByRole("dialog", { name: translate("palette.title") });
  const input = () => page.getByRole("combobox", { name: translate("palette.title") });
  // The key listener mounts with the signed-in shell, so wait for its top-bar button before pressing keys after a page load.
  const openWithKeys = async () => { await page.getByRole("button", { name: /^Open the command palette/ }).waitFor(); await page.keyboard.press("Control+k"); await palette().waitFor(); };

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Palette Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).waitFor();
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const project = await call<{ id: string }>("get_project", { workspaceId, key: "MOB" });
  await call("create_work_item", { projectId: project.id, title: "Alpha palette item" });
  await call("create_wiki_page", { workspaceId, title: "Alpha palette handbook" });
  await call("create_wiki_page", { workspaceId, projectId: project.id, title: "Alpha palette project page" });

  // Ctrl+K opens from a signed-in screen; Escape closes it and focus returns to the button that had it.
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.waitForURL(`${web}/${slug}/projects/MOB/issues`);
  const paletteButton = page.getByRole("button", { name: /^Open the command palette/ });
  await paletteButton.focus();
  await openWithKeys();
  check(await input().evaluate((element) => element === document.activeElement), "the palette did not focus its search field");
  await page.keyboard.press("Escape");
  await palette().waitFor({ state: "detached" });
  check(await paletteButton.evaluate((element) => element === document.activeElement), "focus did not return to the palette button after Escape");
  // Tab and Shift+Tab stay within the modal palette, and Escape still closes it.
  await openWithKeys();
  await page.keyboard.press("Tab");
  check(await palette().getByRole("button", { name: translate("workItems.close") }).evaluate((element) => element === document.activeElement), "Tab did not move focus to the palette close control");
  await page.keyboard.press("Shift+Tab");
  check(await input().evaluate((element) => element === document.activeElement), "Shift+Tab did not return focus to the palette search field");
  await page.keyboard.press("Escape");
  await palette().waitFor({ state: "detached" });
  console.log("palette ok: Ctrl+K opens, Escape closes and returns focus (also after Tab)");

  // Typing finds work items by title and key, wiki pages, and projects; Enter opens the highlighted result.
  await openWithKeys();
  await input().fill("alpha");
  await page.getByRole("option", { name: /Alpha palette item/ }).waitFor();
  await page.getByRole("option", { name: /Alpha palette handbook/ }).waitFor();
  await page.getByRole("option", { name: /Alpha palette project page.*In project MOB/ }).waitFor();
  await input().fill("MOB-1");
  await page.getByRole("option", { name: /Alpha palette item/ }).waitFor();
  await input().fill("alpha");
  await page.getByRole("option", { name: /Alpha palette item/ }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.waitForURL(`${web}/${slug}/browse/MOB-1`);
  check(await palette().count() === 0, "the palette stayed open after Enter");
  console.log("palette ok: search by title and key, keyboard selection opens the work item");
  await page.screenshot({ path: `${shots}/01-search-result-opened.png` });

  // A project Page found by the palette opens under its project.
  await openWithKeys();
  await input().fill("alpha project");
  await page.getByRole("option", { name: /Alpha palette project page/ }).waitFor();
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`${web.replaceAll(".", "\\.")}/${slug}/projects/MOB/pages/`));
  console.log("palette ok: a project Page opens under its project");

  // Create work item and switch workspace are commands in the palette.
  await openWithKeys();
  await input().fill("New work item in Mobile");
  await page.keyboard.press("Enter");
  const createDialog = page.getByRole("dialog", { name: translate("workItems.modal.title") });
  await createDialog.waitFor();
  await createDialog.getByLabel(translate("workItems.titleField")).fill("Made from the palette");
  await createDialog.getByRole("button", { name: translate("workItems.modal.submit") }).click();
  await createDialog.waitFor({ state: "detached" });
  await page.waitForURL(`${web}/${slug}/browse/MOB-2`);
  console.log("palette ok: create work item from the palette");

  // Switch workspace is a command: a second workspace created through the API is reachable by typing its name.
  await call("create_workspace", { name: "Second palette team", slug: `${slug}-b` });
  await page.reload(); // the palette lists the workspaces the page loaded, so reload to see the new one
  await openWithKeys();
  await input().fill("Second palette team");
  await page.getByRole("option", { name: /Switch to workspace: Second palette team/ }).waitFor();
  await page.keyboard.press("Enter");
  await page.waitForURL(`${web}/${slug}-b`);
  console.log("palette ok: switch workspace runs a command");

  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await openWithKeys();
  await input().fill("Switch theme to Dark");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
  console.log("palette ok: switch theme runs a command");

  // Settings are reachable by typing, and the shortcuts page lists the same keys the palette answers to.
  await openWithKeys();
  await input().fill("Members");
  await page.getByRole("option", { name: translate("members.title") }).first().click();
  await page.waitForURL(`${web}/${slug}/settings/members`);
  await openWithKeys();
  await input().fill(translate("shortcuts.title"));
  await page.keyboard.press("Enter");
  await page.waitForURL(`${web}/account/shortcuts`);
  await page.locator("tbody tr").first().waitFor();
  const rows = await page.locator("tbody tr").allInnerTexts();
  check(rows.some((row) => row.includes("Ctrl K")), `the shortcuts page does not list Ctrl K; rows: ${JSON.stringify(rows)}`);
  check(rows.some((row) => row.includes("Esc")), "the shortcuts page does not list Esc");
  await page.screenshot({ path: `${shots}/02-shortcuts-page-dark.png`, fullPage: true });
  console.log("palette ok: settings and shortcuts page reachable from the palette");

  // Phone width: the palette fits without horizontal scroll and stays usable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem("weft.theme", "light"));
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("button", { name: translate("shell.openMenu") }).click();
  await page.getByRole("button", { name: translate("palette.menuLabel") }).click();
  await palette().waitFor();
  await input().fill("alpha");
  await page.getByRole("option", { name: /Alpha palette item/ }).waitFor();
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, wide: [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 8).map((el) => `${el.tagName}.${String(el.className).slice(0, 60)} right=${Math.round(el.getBoundingClientRect().right)}`) }));
  check(overflow.sw <= overflow.iw, `horizontal page scroll at 390px with the palette open: ${JSON.stringify(overflow)}`);
  await page.screenshot({ path: `${shots}/03-palette-phone-light.png` });
  await page.keyboard.press("Escape");
  console.log("palette ok: phone width, opened from the drawer");

  // Acceptance screenshots cover every specified viewport and both themes with the palette open and search results visible.
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 1180], [768, 1024], [844, 390], [667, 375], [390, 844]] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => { localStorage.setItem("weft.theme", value); document.documentElement.setAttribute("data-theme", value); }, theme);
      await page.goto(`${web}/${slug}/projects/MOB/issues`);
      if (width > 767) await openWithKeys();
      else {
        await page.getByRole("button", { name: translate("shell.openMenu") }).waitFor();
        await page.getByRole("button", { name: translate("shell.openMenu") }).click();
        await page.getByRole("button", { name: translate("palette.menuLabel") }).click();
      }
      await palette().waitFor();
      await input().fill("alpha");
      await page.getByRole("option", { name: /Alpha palette item/ }).waitFor();
      const pageWidth = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      check(pageWidth.scrollWidth <= pageWidth.innerWidth, `horizontal page scroll at ${width}x${height} ${theme}: ${JSON.stringify(pageWidth)}`);
      await page.screenshot({ path: join(acceptanceShots, `command-palette-${width}x${height}-${theme}.png`) });
      await page.keyboard.press("Escape");
      await palette().waitFor({ state: "detached" });
    }
  }

  // The phone-landscape layout is wider than md but still uses coarse-pointer target sizes.
  const touchContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, storageState: await context.storageState() });
  const touchPage = await touchContext.newPage();
  await touchPage.goto(`${web}/${slug}/projects/MOB/issues`);
  const touchPaletteButton = touchPage.getByRole("button", { name: /^Open the command palette/ });
  await touchPaletteButton.tap();
  const touchPalette = touchPage.getByRole("dialog", { name: translate("palette.title") });
  await touchPalette.waitFor();
  await touchPage.getByRole("combobox", { name: translate("palette.title") }).fill("alpha");
  await touchPage.getByRole("option", { name: /Alpha palette item/ }).waitFor();
  const touchTargets = await touchPage.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { width: rect.width, height: rect.height } : null;
    };
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      trigger: bounds('button[aria-label^="Open the command palette"]'),
      close: bounds('[role="dialog"] button[aria-label="Close"]'),
      input: bounds('[cmdk-input]'),
      option: bounds('[cmdk-item]'),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  check(touchTargets.coarse, `phone landscape did not use a coarse pointer: ${JSON.stringify(touchTargets)}`);
  const targetSizes = [touchTargets.trigger, touchTargets.close, touchTargets.input, touchTargets.option];
  check(targetSizes.every((target) => target !== null && target.width >= 44 && target.height >= 44), `a command palette touch target is under 44px: ${JSON.stringify(touchTargets)}`);
  check(touchTargets.scrollWidth <= touchTargets.innerWidth, `horizontal page scroll with touch palette: ${JSON.stringify(touchTargets)}`);
  await touchPage.screenshot({ path: join(acceptanceShots, "command-palette-844x390-touch-light.png") });
  await touchPage.keyboard.press("Escape");
  await touchContext.close();

  // Thai: every palette string and the shortcuts page in Thai, light and dark, at 1440 and 390 px. Screenshots are the review.
  const th = resources.th;
  const thaiInput = () => page.getByRole("combobox", { name: th["palette.title"] });
  await call("set_my_locale", { locale: "th" }); // the saved account language wins over the browser copy, so set it on the account
  await page.evaluate(() => localStorage.setItem("weft.locale", "th"));
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => localStorage.setItem("weft.theme", value), theme);
      await page.goto(`${web}/${slug}/projects/MOB/issues`);
      // Wait for the signed-in shell (its palette button or drawer button) before pressing keys.
      await page.locator(`button[aria-label^="${th["palette.button"]}"]`).or(page.getByRole("button", { name: th["shell.openMenu"] })).first().waitFor();
      if (width > 768) await page.keyboard.press("Control+k");
      else {
        await page.getByRole("button", { name: th["shell.openMenu"] }).click();
        await page.getByRole("button", { name: th["palette.menuLabel"] }).click();
      }
      await page.getByRole("dialog", { name: th["palette.title"] }).waitFor();
      await page.screenshot({ path: `${shots}/th-${width}-${theme}-empty.png` });
      await thaiInput().fill("alpha");
      await page.getByRole("option", { name: /Alpha palette project page/ }).waitFor();
      await page.screenshot({ path: `${shots}/th-${width}-${theme}-search.png` });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal page scroll in Thai at ${width}px ${theme}`);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog", { name: th["palette.title"] }).waitFor({ state: "detached" });
    }
  }
  await page.goto(`${web}/account/shortcuts`);
  await page.locator("tbody tr").first().waitFor();
  await page.screenshot({ path: `${shots}/th-shortcuts-1440-dark.png`, fullPage: true });
  console.log("palette ok: Thai palette and shortcuts page at 1440 and 390, light and dark");

  console.log("e2e command-palette: ok");
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
