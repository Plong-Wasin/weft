// Browser end-to-end flow: submit a work item to Intake, accept it, check it leaves Triage and shows in the project list.
// Run with `bun run e2e` (needs the shared weft-postgres container; set DATABASE_URL to use your own database).
import { chromium, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3108);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5208);
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
  await page.getByLabel(translate("auth.name")).fill("Intake Tester");
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

  await page.getByRole("link", { name: translate("intake.title") }).click();
  await page.getByRole("button", { name: translate("intake.submit"), exact: true }).waitFor();
  await page.getByLabel(translate("intake.titleField")).fill("Dark mode please");
  await page.getByRole("button", { name: translate("intake.submit"), exact: true }).click();
  await page.getByTestId("intake-MOB-1").waitFor();

  // Still in Triage: the normal project list does not show it.
  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("textbox", { name: translate("workItems.titleField") }).waitFor();
  check(await page.getByRole("link", { name: /Dark mode please/ }).count() === 0, "a Triage work item showed in the project list");

  await page.goto(`${web}/${slug}/projects/MOB/intake`);
  await page.getByTestId("intake-MOB-1").getByRole("button", { name: translate("intake.accept"), exact: true }).click();
  await page.getByText(translate("intake.empty")).waitFor();
  await page.getByRole("tab", { name: translate("intake.tab.accepted") }).click();
  await page.getByTestId("intake-MOB-1").waitFor();

  await page.goto(`${web}/${slug}/projects/MOB/issues`);
  await page.getByRole("link", { name: /Dark mode please/ }).waitFor();
  console.log("e2e intake: ok");
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
