// Browser check for the work item surfaces: the comment composer is a bordered card with an inset Comment button,
// the Assignees picker searches with one member (and says when nothing matches), the Work item detail shows a skeleton with aria-busy while it loads,
// and an empty project shows one empty state with a working Add work item button in the list, board and spreadsheet layouts.
// Each named step is one acceptance checkbox of the ticket. Run with `bun e2e/work-item-surfaces.e2e.ts`.
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31440);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52440);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("ux-21-work-item-surfaces");
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
const { client, db } = createDatabase();
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const t = (key: string) => translate(key as never);
  const call = async <T>(name: string, body: unknown) => {
    const response = await page.request.post(`${api}/actions/${name}`, { data: body });
    check(response.ok(), `${name} failed: ${response.status()}`);
    return await response.json() as T;
  };
  const step = async (name: string, run: () => Promise<void>) => { await run(); console.log(`ok - ${name}`); };

  await page.goto(web);
  await page.getByRole("button", { name: t("auth.signUp"), exact: true }).click();
  await page.getByLabel(t("auth.name")).fill("Surfaces Tester");
  await page.getByLabel(t("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(t("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(t("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: t("auth.signUp") }).click();
  await page.getByLabel(t("workspace.name")).fill("Surfaces team");
  await page.getByLabel(t("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: t("workspace.create") }).click();
  await page.getByRole("button", { name: t("projects.new"), exact: true }).click();
  await page.getByLabel(t("projects.name")).fill("Solo");
  await page.getByLabel(t("projects.key"), { exact: true }).fill("SOL");
  await page.getByText(t("projects.shapeFull"), { exact: true }).click();
  await page.getByRole("button", { name: t("projects.create") }).click();
  await page.getByRole("link", { name: /SOL · Solo/ }).waitFor();

  // A second project with no Work items, for the empty state. Its name keeps it apart from the Solo project in the list.
  const me = await (await page.request.get(`${api}/api/me`)).json() as { user: { id: string; name: string }; workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  const solo = await call<{ id: string }>("get_project", { workspaceId, key: "SOL" });
  await call("create_work_item", { projectId: solo.id, title: "Solo item" });
  await call("create_project", { workspaceId, name: "Empty", key: "EMP", visibility: "private", shape: "full" });

  await step("composer: bordered card, surface, padding and an inset Comment button in dark at 1440 and 390 px", async () => {
    await page.evaluate(() => localStorage.setItem("weft.theme", "dark"));
    await page.goto(`${web}/${slug}/browse/SOL-1`);
    const submit = page.locator(".editor-footer").getByRole("button", { name: t("comments.add"), exact: true });
    await submit.waitFor();
    const measure = () => submit.evaluate((button) => {
      const card = button.closest<HTMLElement>("[data-comment-composer]")!;
      const style = getComputedStyle(card);
      const box = card.getBoundingClientRect();
      const btn = button.getBoundingClientRect();
      return {
        border: parseFloat(style.borderTopWidth), background: style.backgroundColor, padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map((value) => parseFloat(value)),
        insetRight: box.right - btn.right, insetBottom: box.bottom - btn.bottom, insetLeft: btn.left - box.left,
      };
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const wide = await measure();
    check(wide.border > 0, `the composer card should have a border, got ${wide.border}px`);
    check(wide.background !== "rgba(0, 0, 0, 0)" && wide.background !== "transparent", `the composer card should have a surface colour, got ${wide.background}`);
    check(wide.padding.every((value) => value >= 12), `the composer card should pad all sides, got ${wide.padding.join(" ")}`);
    check(wide.insetRight >= 12 && wide.insetBottom >= 12, `the Comment button should sit inside the card, insets right ${wide.insetRight}px bottom ${wide.insetBottom}px`);
    await page.getByRole("complementary", { name: t("workItems.properties") }).waitFor();
    await submit.scrollIntoViewIfNeeded();
    await submit.locator("xpath=ancestor::div[@data-comment-composer][1]").screenshot({ path: `${shots}/composer-1440-dark.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await submit.scrollIntoViewIfNeeded();
    const narrow = await measure();
    check(narrow.insetRight >= 12 && narrow.insetBottom >= 12, `at 390 px the Comment button should sit inside the card, insets right ${narrow.insetRight}px bottom ${narrow.insetBottom}px`);
    await submit.locator("xpath=ancestor::div[@data-comment-composer][1]").screenshot({ path: `${shots}/composer-390-dark.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await step("assignees: search field shows with one member; typing filters; no match says so; Enter and Escape work; also in the Create work item dialog", async () => {
    await page.goto(`${web}/${slug}/browse/SOL-1`);
    const sidebar = page.getByRole("complementary", { name: t("workItems.properties") });
    const panel = page.locator("[data-popover-panel]");
    const searchField = panel.getByRole("searchbox", { name: t("picker.search") });
    await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.assignees")}:`) }).click();
    await searchField.waitFor();
    check(await searchField.evaluate((element) => element === document.activeElement), "the search field should be focused on open");
    check(await panel.getByRole("menuitemcheckbox").count() === 1, "the Solo project should list one member");
    await page.keyboard.type("zzz");
    await panel.getByText(t("picker.noMatches"), { exact: true }).waitFor();
    check(await panel.getByRole("menuitemcheckbox").count() === 0, "a query with no match should list nobody");
    await searchField.fill("surf");
    await panel.getByRole("menuitemcheckbox", { name: /Surfaces Tester/ }).waitFor();
    check(await panel.getByRole("menuitemcheckbox").count() === 1, "typing should keep the one matching member");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-popover-panel] [role="menuitemcheckbox"][aria-checked="true"]') !== null);
    check(await panel.isVisible(), "Enter should keep the multi-select picker open");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await sidebar.getByRole("button", { name: new RegExp(`^${t("workItems.assignees")}: .*Surfaces Tester`) }).waitFor();

    // The Create work item dialog: the same picker with the same search field.
    await page.goto(`${web}/${slug}/projects/SOL/issues`);
    await page.getByRole("button", { name: t("workItems.addNew"), exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: t("workItems.create") });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: new RegExp(`^${t("workItems.assignees")}:`) }).click();
    await panel.getByRole("searchbox", { name: t("picker.search") }).waitFor();
    check(await panel.getByRole("menuitemcheckbox").count() === 1, "the Create dialog should list the one member");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" }).catch(() => undefined);
  });

  await step("detail loading: skeleton with aria-busy while the item loads (API delayed), then the item", async () => {
    await page.route("**/actions/get_work_item", async (route) => { await Bun.sleep(2000); await route.continue(); });
    await page.goto(`${web}/${slug}/browse/SOL-1`);
    const skeleton = page.locator('[data-testid="work-item-skeleton"]');
    await skeleton.waitFor();
    check(await skeleton.getAttribute("aria-busy") === "true", "the loading skeleton should carry aria-busy=true");
    check(await skeleton.locator("div[class*='animate-pulse']").count() >= 3, "the skeleton should show title and description blocks");
    await page.screenshot({ path: `${shots}/detail-loading-skeleton-1440.png` });
    await page.unroute("**/actions/get_work_item");
    await page.getByRole("textbox", { name: t("workItems.titleField") }).waitFor();
    check(await page.locator('[data-testid="work-item-skeleton"]').count() === 0, "the skeleton should go once the item loads");
  });

  await step("empty project: one empty state with a working Add work item button in list, board and spreadsheet", async () => {
    for (const layout of ["list", "board", "spreadsheet"]) {
      await page.goto(`${web}/${slug}/projects/EMP/issues${layout === "list" ? "" : `?layout=${layout}`}`);
      const block = page.getByRole("status").filter({ hasText: t("workItems.emptyHint") });
      await block.waitFor();
      check(await block.getByText(t("workItems.empty"), { exact: true }).count() === 1, `${layout}: the empty title should show`);
      await block.getByRole("button", { name: t("workItems.addNew"), exact: true }).click();
      const dialog = page.getByRole("dialog", { name: t("workItems.create") });
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" }).catch(() => undefined);
      if (layout === "list") await page.screenshot({ path: `${shots}/empty-project-1440.png` });
    }
  });

  console.log("e2e work-item-surfaces: composer card, Assignees search, detail skeleton and empty project ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
