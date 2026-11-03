// Browser end-to-end flow for Project key suggestions on Create project.
// Run with `bun e2e/project-key.e2e.ts` (needs the shared weft-postgres container).
import { chromium } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31168);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52168);
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

const check = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ locale: "en-US" });
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Key Flow Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Key Flow Team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();

  const openForm = async () => { if (!(await page.getByLabel(translate("projects.name")).isVisible())) await page.getByRole("button", { name: translate("projects.new"), exact: true }).first().click(); };
  await openForm();
  const name = page.getByLabel(translate("projects.name"));
  const key = page.getByLabel(translate("projects.key"), { exact: true });
  const create = page.getByRole("button", { name: translate("projects.create") });
  await name.fill("Demo Project");
  check(await key.inputValue() === "DEMOPROJEC", "name did not suggest the sanitized key");
  await name.fill("");
  check(await key.inputValue() === "", "clearing the name did not clear the suggested key");

  await name.fill("Alpha Project");
  check(await key.inputValue() === "ALPHAPROJE", "name did not restore a fresh suggestion");
  await key.fill("MYKEY");
  await name.fill("Alpha Projects");
  check(await key.inputValue() === "MYKEY", "typing the name overwrote a manually edited key");
  await create.click();
  await page.getByRole("link", { name: "MYKEY · Alpha Projects" }).waitFor();
  check(!(await name.isVisible()), "successful create did not close the form");
  await openForm();
  check(await name.inputValue() === "" && await key.inputValue() === "", "successful create did not reset form fields");

  await name.fill("โครงการภาษาไทย");
  check(await key.inputValue() === "", "Thai-only name produced a key suggestion");
  check(!(await create.isEnabled()) || !(await key.evaluate((input: HTMLInputElement) => input.checkValidity())), "Thai-only name unexpectedly permits an empty key");
  await key.fill("VALID");
  await create.click();
  await page.getByRole("link", { name: "VALID · โครงการภาษาไทย" }).waitFor();
  await openForm();
  check(await name.inputValue() === "" && await key.inputValue() === "", "successful Thai project create did not reset the form");

  await name.fill("Duplicate");
  await key.fill("MYKEY");
  await create.click();
  await page.getByRole("alert").getByText("Project key is already taken").waitFor();
  check(await name.inputValue() === "Duplicate" && await key.inputValue() === "MYKEY", "failed create unexpectedly reset the form");
  await browser.close();
  console.log("project key ok: suggestion, manual override, empty/Thai name, reset, taken-key rejection");
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
