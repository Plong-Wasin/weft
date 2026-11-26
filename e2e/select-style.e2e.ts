// Browser coverage for the Base UI ordering trigger and the native Wiki detail selects.
import { chromium, type Locator } from "playwright";
import { controlAppearance } from "./control-appearance";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31420);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52420);
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

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Select Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Select team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByRole("button", { name: translate("projects.new"), exact: true }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("SEL");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /SEL · Mobile/ }).waitFor();

  const me = await (await page.request.get(`${api}/api/me`)).json() as any;
  const workspaceId = me.workspaces.find((workspace: any) => workspace.slug === slug).id;
  const call = async (name: string, data: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data })).json() as any;
  const project = (await call("list_projects", { workspaceId, archived: false })).find((entry: any) => entry.key === "SEL");
  const live = await call("create_wiki_page", { workspaceId, projectId: project.id, title: "Release plan" });
  const old = await call("create_wiki_page", { workspaceId, projectId: project.id, title: "Old notes" });
  await call("archive_wiki_page", { pageId: old.id });

  const t = (key: string) => translate(key as never);
  const enabledOrder = page.getByRole("combobox", { name: t("pages.order"), exact: true });
  await page.goto(`${web}/${slug}/projects/SEL/pages`);
  await enabledOrder.waitFor();
  const chevron = enabledOrder.locator("svg.lucide-chevron-down[aria-hidden=true]");
  check(await chevron.count() === 1 && await chevron.isVisible(), "Base UI order trigger has one visible down chevron");
  const exerciseEnabledSelect = async (control: Locator, name: string) => {
    const settle = () => control.evaluate(async (element) => {
      await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
    });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.mouse.move(0, 0);
      await settle();
      const idle = await controlAppearance(control);
      check(idle.borderVisible, `${name} has a visible border in ${theme}`);
      await control.hover();
      await settle();
      const hovered = await controlAppearance(control);
      check(hovered.borderVisible && hovered.borderColor !== idle.borderColor, `${name} visibly changes its border on hover in ${theme}`);
      await page.mouse.move(0, 0);
      // Shift+Tab from the next position in the sequential order gives the trigger keyboard focus.
      await control.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await settle();
      const focused = await controlAppearance(control);
      check(focused.focusVisible, `${name} has keyboard focus in ${theme}`);
      check((focused.outline !== null && focused.outline !== hovered.outline) || focused.rings.some((ring) => !hovered.rings.includes(ring)), `${name} draws a visible keyboard focus indicator distinct from hover in ${theme}`);
      await control.blur();
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  };
  await exerciseEnabledSelect(enabledOrder, "Base UI order trigger");

  // An archived page locks its native Parent page select.
  await page.goto(`${web}/${slug}/projects/SEL/pages/${live.id}`);
  // The Details panel starts hidden: open it before looking at its selects.
  const openDetails = async () => { const toggle = page.getByTestId("wiki-details-toggle"); await toggle.waitFor(); if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click(); };
  await openDetails();
  const enabledAccess = page.locator("label", { hasText: t("wiki.access") }).locator("select").first();
  await enabledAccess.waitFor();
  const enabled = await controlAppearance(enabledAccess);
  check(enabled.backgroundImage.includes("url("), "native select draws its down chevron as a background image");
  await exerciseEnabledSelect(enabledAccess, "native access select");

  await page.goto(`${web}/${slug}/projects/SEL/pages/${old.id}`);
  await openDetails();
  const disabledParent = page.locator("label", { hasText: t("wiki.parent") }).locator("select");
  await disabledParent.waitFor();
  check(await disabledParent.isDisabled(), "archived page parent select should be disabled");
  const disabled = await controlAppearance(disabledParent);
  check(disabled.cursor === "not-allowed", "disabled select should show a not-allowed cursor");
  check(disabled.backgroundColor !== enabled.backgroundColor || disabled.color !== enabled.color, "disabled select should look different from an enabled one");

  console.log("e2e select style: chevron, hover, focus ring and disabled state ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
