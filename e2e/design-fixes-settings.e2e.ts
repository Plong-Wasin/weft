// Browser end-to-end flow: design fixes for the workspace and project settings.
// Phone width: every settings route fits without a sideways page scroll, a long member name is not cut off, and the
// Members and access section sits clear of the member list. Desktop: a project state group shows no add field until
// "Add state" opens it, and a state created through it appears in the group.
// Run with `bun e2e/design-fixes-settings.e2e.ts` (set DATABASE_URL to an isolated test database).
import { chromium } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31440);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52440);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31442);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "apps/live/src/index.ts"], { env: { ...Bun.env, LIVE_PORT: String(livePort), WEB_ORIGIN: web }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api, VITE_LIVE_URL: `ws://localhost:${livePort}` }, stdout: "ignore", stderr: "inherit" }),
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
  const longName = "Design Tester With A Long Display Name";
  const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const call = async <T>(name: string, body: unknown) => await (await page.request.post(`${api}/actions/${name}`, { data: body })).json() as T;
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  // Sign up, make a workspace and a project.
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill(longName);
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Settings fixes");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/actions/create_workspace")), page.getByRole("button", { name: translate("workspace.create") }).click()]);
  const me = await (await page.request.get(`${api}/api/me`)).json() as { workspaces: Array<{ id: string; slug: string }> };
  const workspaceId = me.workspaces.find((item) => item.slug === slug)!.id;
  await call("create_project", { workspaceId, name: "Settings archive", key: "SET", visibility: "public" });

  // Every settings route fits the phone and the desktop width without a sideways scroll.
  const routes = ["settings", "settings/members", "settings/projects/SET", "settings/projects/SET/states", "settings/projects/SET/estimates", "settings/projects/SET/labels", "settings/projects/SET/features"];
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of routes) {
      await page.goto(`${web}/${slug}/${route}`);
      await page.getByRole("heading").first().waitFor();
      check(await noSideScroll(), `/${route} scrolls the page sideways at ${width}px`);
    }
  }
  console.log("settings ok: all routes fit at 390 and 1440 without a sideways scroll");

  // Members at phone width: the long name is shown whole, and the Members and access section is clear of the list above it.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${web}/${slug}/settings/members`);
  const memberName = page.getByText(longName, { exact: true }).first();
  await memberName.waitFor();
  const nameWhole = await memberName.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
  check(nameWhole, "a long member name is cut off on phone width");
  const heading = page.getByRole("heading", { name: translate("account.adminTitle"), exact: true });
  const listBottom = await memberName.evaluate((node) => node.closest("ul")!.getBoundingClientRect().bottom);
  const gap = (await heading.boundingBox())!.y - listBottom;
  check(gap >= 24, `the Members and access heading sits ${gap}px below the member list; expected at least 24px`);
  console.log("members ok: long name whole on phone, section clear of the list");

  // States at desktop width: the add field of a group is hidden until "Add state" opens it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${web}/${slug}/settings/projects/SET/states`);
  const startedBlock = page.locator("section").filter({ has: page.getByRole("heading", { name: translate("states.group.started") }) }).last();
  await startedBlock.getByRole("heading", { name: translate("states.group.started") }).waitFor();
  check((await startedBlock.getByLabel(translate("states.name")).count()) === 0, "the add field shows before Add state is pressed");
  const reveal = startedBlock.getByRole("button", { name: translate("states.add"), exact: true });
  await reveal.click();
  check((await reveal.getAttribute("aria-expanded")) === "true", "Add state does not report that it is open");
  await startedBlock.getByLabel(translate("states.name")).fill("Review");
  await startedBlock.getByRole("button", { name: translate("states.create"), exact: true }).click();
  await startedBlock.getByText("Review", { exact: true }).waitFor();
  check((await startedBlock.getByLabel(translate("states.name")).count()) === 0, "the add field stays open after a state is created");
  console.log("states ok: add field opens from Add state, creates a state and closes");

  console.log("design fixes settings: all checks passed");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  process.exit(failed ? 1 : 0);
}
