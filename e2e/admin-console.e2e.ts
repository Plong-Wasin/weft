// Admin console: an Admin suspends a member in the browser; a person whose password reset is forced lands on the change-password screen and can save a new password.
import { chromium, type BrowserContext } from "playwright";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31191);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52191);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const password = "a-secure-password";
const slug = `admin-e2e-${crypto.randomUUID().slice(0, 8)}`;

const webBuild = Bun.spawnSync(["node", "node_modules/vite/bin/vite.js", "build"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "inherit", stderr: "inherit" });
if (webBuild.exitCode !== 0) throw new Error("Could not build the web app for the admin console browser flow");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["node", "node_modules/vite/bin/vite.js", "preview", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) { try { if ((await fetch(url)).status < 500) return; } catch { /* starting */ } await Bun.sleep(200); }
  throw new Error(`${url} did not start`);
}
const call = (path: string, body: unknown, cookie?: string) => fetch(`${api}${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
async function signUp(name: string) {
  const email = `${name.toLowerCase().replace(/\W+/g, "")}-${crypto.randomUUID().slice(0, 6)}@example.test`;
  const response = await call("/api/auth/sign-up/email", { name, email, password });
  const body = await response.json() as { user: { id: string } };
  return { id: body.user.id, email, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}
async function signIn(email: string) {
  return (await call("/api/auth/sign-in/email", { email, password })).headers.get("set-cookie")!.split(";")[0]!;
}
async function sessionContext(browser: Awaited<ReturnType<typeof chromium.launch>>, cookie: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", serviceWorkers: "block" });
  const [name, ...rest] = cookie.split("=");
  await context.addCookies([{ name: name!, value: rest.join("="), domain: "localhost", path: "/" }]);
  return context;
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await Promise.all([waitFor(`${api}/api/config`), waitFor(web)]);
  const admin = await signUp("Ada Admin");
  const workspace = await (await call("/actions/create_workspace", { name: "Admin E2E", slug }, admin.cookie)).json() as { id: string };
  const ben = await signUp("Ben Member");
  const dao = await signUp("Dao Reset");
  for (const person of [ben, dao]) {
    const invite = await (await call("/actions/create_invite", { workspaceId: workspace.id, role: "Member" }, admin.cookie)).json() as { token: string };
    await call("/actions/accept_invite", { token: invite.token }, person.cookie);
  }
  await call("/actions/force_password_reset", { workspaceId: workspace.id, userId: dao.id, reason: "Shared password in a chat" }, admin.cookie);
  const daoCookie = await signIn(dao.email);

  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });

  // Admin suspends a member from the members page.
  const adminContext = await sessionContext(browser, await signIn(admin.email));
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`${web}/${slug}/settings/members`);
  await adminPage.getByText("Members and access").waitFor({ timeout: 20_000 });
  // Rows sort by name: Ada (self, no suspend), Ben, Dao.
  await adminPage.getByRole("button", { name: translate("account.suspend"), exact: true }).first().waitFor();
  adminPage.once("dialog", (dialog) => void dialog.accept());
  await adminPage.getByRole("button", { name: translate("account.suspend"), exact: true }).first().click();
  await adminPage.getByText(translate("account.statusSuspended"), { exact: true }).first().waitFor({ timeout: 10_000 });
  await adminContext.close();

  // A person with a forced reset lands on the change-password screen and can save a new password.
  const daoContext = await sessionContext(browser, daoCookie);
  const daoPage = await daoContext.newPage();
  await daoPage.goto(`${web}/${slug}`);
  await daoPage.getByRole("heading", { name: translate("account.resetTitle") }).waitFor({ timeout: 20_000 });
  if (!daoPage.url().endsWith("/account/password")) throw new Error(`reset redirect landed on ${daoPage.url()}`);
  await daoPage.getByLabel(translate("account.currentPassword")).fill(password);
  await daoPage.getByLabel(translate("account.newPassword")).fill("a-brand-new-password");
  await daoPage.getByLabel(translate("auth.confirmPassword")).fill("a-brand-new-password");
  await daoPage.getByRole("button", { name: translate("account.resetSave") }).click();
  await daoPage.waitForURL((url) => !url.pathname.endsWith("/account/password"), { timeout: 20_000 });
  await daoContext.close();
  console.log("e2e admin-console: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
