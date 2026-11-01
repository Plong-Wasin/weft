// Browser end-to-end flow: every route at its Plane-style URL, design tokens in light and dark, Inter and icons, legacy URLs.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3109);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5209);
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
  const page = await browser.newPage();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  await page.goto(web);
  await page.getByLabel(translate("auth.name")).fill("Routes Tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password")).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("E2E team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.getByLabel(translate("projects.name")).fill("Mobile");
  await page.getByLabel(translate("projects.key"), { exact: true }).fill("MOB");
  await page.getByRole("button", { name: translate("projects.create") }).click();
  await page.getByRole("link", { name: /MOB · Mobile/ }).click();
  await page.getByRole("button", { name: translate("workItems.new"), exact: true }).click();
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).fill("Alpha");
  await page.getByRole("button", { name: translate("workItems.create") }).click();
  await page.getByRole("link", { name: /Alpha/ }).waitFor();
  check(page.url() === `${web}/${slug}/projects/MOB/issues`, `work items URL is ${page.url()}`);

  // Each route renders its screen when opened directly (full page load), at Plane's URL shape.
  const screens: Array<[string, () => Promise<unknown>]> = [
    [`/${slug}`, () => page.getByRole("heading", { name: translate("projects.title") }).waitFor()],
    [`/${slug}/projects`, () => page.getByRole("heading", { name: translate("projects.title") }).waitFor()],
    [`/${slug}/projects/MOB`, () => page.getByRole("link", { name: /Alpha/ }).waitFor()],
    [`/${slug}/projects/MOB/issues`, () => page.getByRole("link", { name: /Alpha/ }).waitFor()],
    [`/${slug}/browse/MOB-1`, () => page.getByRole("heading", { name: "MOB-1" }).waitFor()],
    [`/${slug}/projects/MOB/cycles`, () => page.getByRole("heading", { name: translate("cycles.title") }).waitFor()],
    [`/${slug}/projects/MOB/modules`, () => page.getByRole("heading", { name: translate("modules.title") }).waitFor()],
    [`/${slug}/projects/MOB/views`, () => page.getByText(translate("route.comingSoon")).waitFor()],
    [`/${slug}/projects/MOB/pages`, () => page.getByRole("heading", { name: translate("projectNav.pages") }).waitFor()],
    [`/${slug}/projects/MOB/intake`, () => page.getByRole("button", { name: translate("intake.add"), exact: true }).waitFor()],
    [`/${slug}/settings/projects/MOB`, () => page.getByRole("heading", { name: translate("settings.general") }).waitFor()],
    [`/${slug}/settings/projects/MOB/members`, () => page.getByRole("heading", { name: translate("projects.members") }).waitFor()],
    [`/${slug}/settings/projects/MOB/labels`, () => page.getByRole("heading", { name: translate("labels.title") }).waitFor()],
    [`/${slug}/settings/projects/MOB/states`, () => page.getByRole("heading", { name: translate("states.title"), exact: true }).waitFor()],
    [`/${slug}/settings/projects/MOB/features`, () => page.getByRole("heading", { name: translate("settings.features") }).waitFor()],
    [`/${slug}/settings`, () => page.getByRole("heading", { name: translate("settings.workspaceTitle") }).waitFor()],
    [`/${slug}/settings/members`, () => page.getByRole("heading", { name: translate("members.title") }).waitFor()],
    [`/${slug}/settings/invites`, () => page.getByRole("heading", { name: translate("settings.invites") }).waitFor()],
    [`/${slug}/notifications`, () => page.getByRole("heading", { name: new RegExp(translate("inbox.title")) }).waitFor()],
    [`/${slug}/wiki`, () => page.getByRole("heading", { name: translate("wiki.title") }).waitFor()],
    [`/${slug}/ai`, () => page.getByRole("heading", { name: translate("ai.heading") }).waitFor()],
  ];
  for (const [path, ready] of screens) {
    await page.goto(`${web}${path}`);
    await ready();
    console.log(`route ok: ${path}`);
  }

  // URLs from before the Plane-style routes redirect.
  await page.goto(`${web}/${slug}/work-items/MOB-1`);
  await page.getByRole("heading", { name: "MOB-1" }).waitFor();
  check(page.url() === `${web}/${slug}/browse/MOB-1`, `legacy work item URL went to ${page.url()}`);
  await page.goto(`${web}/${slug}/inbox`);
  await page.getByRole("heading", { name: new RegExp(translate("inbox.title")) }).waitFor();
  check(page.url() === `${web}/${slug}/notifications`, `legacy inbox URL went to ${page.url()}`);

  // Tokens: Plane's values, light and dark, defined once as CSS variables. Values are the ones Plane serves.
  const tokens = () => page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim();
    return { theme: document.documentElement.getAttribute("data-theme"), canvas: read("--bg-canvas"), surface: read("--bg-surface-1"), text: read("--txt-primary"), accent: read("--bg-accent-primary"), border: read("--border-subtle"), bodyBg: getComputedStyle(document.body).backgroundColor, bodyColor: getComputedStyle(document.body).color, radius: read("--radius-md"), header: read("--height-header"), size: read("--text-14") };
  });
  const light = { canvas: "oklch(95.43% .001 230.67)", surface: "oklch(100% 0 0)", text: "oklch(23.78% .0029 230.83)", accent: "oklch(47.99% .1158 242.91)", border: "oklch(93.89% .0014 230.68)" };
  const dark = { canvas: "oklch(16.89% .0021 230.81)", surface: "oklch(19.32% .002 230.81)", text: "oklch(92.35% .001733 230.685)", accent: "oklch(63.11% .126281 238.01)", border: "oklch(25.93% .0033 230.84)" };
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${web}/${slug}`);
  await page.getByRole("heading", { name: translate("projects.title") }).waitFor();
  const lightTokens = await tokens();
  for (const key of Object.keys(light) as Array<keyof typeof light>) check(lightTokens[key] === light[key], `light ${key}: ${lightTokens[key]}`);
  check(lightTokens.theme === "light" && lightTokens.radius === ".375rem" && lightTokens.header === "3.25rem" && lightTokens.size === ".875rem", `light scale tokens: ${JSON.stringify(lightTokens)}`);
  // System theme follows the OS preference.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await page.getByRole("heading", { name: translate("projects.title") }).waitFor();
  const darkTokens = await tokens();
  for (const key of Object.keys(dark) as Array<keyof typeof dark>) check(darkTokens[key] === dark[key], `dark ${key}: ${darkTokens[key]}`);
  check(darkTokens.theme === "dark" && darkTokens.bodyBg !== lightTokens.bodyBg && darkTokens.bodyColor !== lightTokens.bodyColor, "dark theme did not restyle the page");
  // The theme switch overrides the system, and sticks across a reload.
  await page.getByRole("button", { name: translate("profile.menu") }).click();
  await page.getByRole("menuitemradio", { name: translate("theme.light") }).click();
  check((await tokens()).theme === "light", "theme switch did not apply light");
  await page.reload();
  await page.getByRole("heading", { name: translate("projects.title") }).waitFor();
  check((await tokens()).theme === "light", "chosen theme did not survive reload");

  // Inter and the icon set are available to every screen (shell, project menu).
  const inter = await page.evaluate(async () => { await document.fonts.ready; return { family: getComputedStyle(document.body).fontFamily, loaded: [...document.fonts].some((face) => face.family.includes("Inter") && face.status === "loaded") }; });
  check(inter.family.startsWith('"Inter Variable"') && inter.loaded, `Inter not applied: ${JSON.stringify(inter)}`);
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("navigation", { name: new RegExp(translate("projectNav.label")) }).waitFor();
  check(await page.locator("nav svg.lucide").count() >= 6, "icons missing from the shell and project menu");

  console.log("e2e routes: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  // The flow commits real rows (the servers use their own connections), so remove them: other tests expect an empty instance.
  const { client, db } = createDatabase();
  await db.delete(workspaces).where(like(workspaces.slug, "e2e-%"));
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
