import { chromium } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31420);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52420);
const livePort = Number(Bun.env.E2E_LIVE_PORT ?? 31422);
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Wiki tester");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Wiki not found");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/actions/create_workspace")), page.getByRole("button", { name: translate("workspace.create") }).click()]);

  const missingId = "00000000-0000-4000-8000-000000000001";
  await page.goto(`${web}/${slug}/wiki/${missingId}`);
  await page.getByRole("heading", { name: translate("app.notFound"), exact: true }).waitFor();
  await page.getByText(translate("app.notFoundHint"), { exact: true }).waitFor();
  const recoveryLink = page.getByRole("main").getByRole("link", { name: translate("wiki.title"), exact: true });
  await recoveryLink.waitFor();
  if (!(await recoveryLink.evaluate((node) => node.getBoundingClientRect().height >= 36))) throw new Error("Wiki recovery link is not rendered as an accessible button-size action");
  const desktopPath = `${Bun.env.TMPDIR ?? "/tmp"}/wiki-not-found-desktop.png`;
  const mobilePath = `${Bun.env.TMPDIR ?? "/tmp"}/wiki-not-found-mobile.png`;
  await page.screenshot({ path: desktopPath, fullPage: true });
  console.log(`Wiki missing-page desktop render: ${desktopPath}`);
  console.log(`Desktop alert text: ${(await page.getByRole("alert").innerText()).replaceAll("\n", " | ")}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: mobilePath, fullPage: true });
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  if (!fits) throw new Error("Wiki missing-page screen scrolls horizontally on phone width");
  console.log(`Wiki missing-page mobile render: ${mobilePath}`);
  await recoveryLink.click();
  await page.waitForURL(`${web}/${slug}/wiki`);
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  process.exit(failed ? 1 : 0);
}
