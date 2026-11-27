// Browser end-to-end flow: the sign-in wait and lock messages read plainly at 1440px and 390px, in light and dark.
// Needs an empty isolated database: create one with `bun run test:isolated --keep <any test file>` and set DATABASE_URL to the
// database it prints. Screenshots land in .local/visual/review/32-sign-in-limits/.
import { check, launchBrowser, newContext, productionWeb, serveWeb, startApi, waitFor } from "./harness";
import type { Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3132);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5232);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("32-sign-in-limits");
const password = "a-secure-password";
const webBuild = await productionWeb(api);
const servers: Array<ReturnType<typeof Bun.spawn>> = [
  startApi(apiPort, web, { env: { ...Bun.env, ALLOW_SIGNUP: "true", PASSWORD_BREACH_CHECK: "off", SMTP_HOST: "" } }),
];
servers.push(serveWeb(webPort, webBuild.directory));
const sizes = { "1440": { width: 1440, height: 900 }, "390": { width: 390, height: 844 } } as const;
const themes = ["light", "dark"] as const;

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** Creates an account through the API, the same call the sign-up form makes. */
async function createAccount(email: string) {
  const response = await fetch(`${api}/api/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: web },
    body: JSON.stringify({ name: "Ada", email, password }),
  });
  check(response.status === 200, `sign-up for ${email} failed with ${response.status}`);
}

/** Wrong-password sign-ins through the API. Three failures start the wait; the fifth locks. The sleeps follow the waits (2 s, then 4 s). */
async function failSignIns(email: string, count: number, sleepAfterFailure: Record<number, number> = {}) {
  for (let attempt = 0; attempt < count; attempt += 1) {
    const response = await fetch(`${api}/api/auth/sign-in/email`, {
      method: "POST", headers: { "content-type": "application/json", origin: web },
      body: JSON.stringify({ email, password: "wrong-password-1" }),
    });
    check(response.status === 401, `expected 401 on failure ${attempt + 1}, got ${response.status}`);
    if (sleepAfterFailure[attempt]) await Bun.sleep(sleepAfterFailure[attempt]);
  }
}

async function openSignIn(browser: Awaited<ReturnType<typeof launchBrowser>>, size: keyof typeof sizes, theme: (typeof themes)[number]) {
  const context = await newContext(browser, { viewport: sizes[size], locale: "en-US", colorScheme: theme });
  const page = await context.newPage();
  await page.goto(web);
  await page.getByRole("heading", { name: new RegExp(translate("app.welcome")) }).waitFor();
  return { context, page };
}

/** Fills the sign-in form, submits, and returns the one message the form shows. */
async function submitSignIn(page: Page, email: string, typedPassword: string) {
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill(typedPassword);
  await page.getByRole("button", { name: translate("auth.signIn"), exact: true }).last().click();
  const alert = page.getByRole("alert");
  await alert.waitFor();
  return (await alert.innerText()).trim();
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/health/live`), waitFor(web)]);
  const browser = await launchBrowser();
  const id = crypto.randomUUID().slice(0, 8);

  // One account is locked for every screenshot: the lock lasts 15 minutes, so it is set once, after the waits.
  const lockedEmail = `e2e-lock-${id}@example.test`;
  await createAccount(lockedEmail);
  await failSignIns(lockedEmail, 5, { 2: 2_100, 3: 4_100 });
  const lockText = translate("auth.signInLocked").replace("{minutes}", "15");

  for (const theme of themes) {
    for (const size of Object.keys(sizes) as Array<keyof typeof sizes>) {
      // Wait: this account has three failures and no more, so the next attempt within two seconds is refused with the wait.
      const waitEmail = `e2e-wait-${theme}-${size}-${id}@example.test`;
      await createAccount(waitEmail);
      const waiting = await openSignIn(browser, size, theme);
      await waiting.page.getByLabel(translate("auth.email")).fill(waitEmail);
      await waiting.page.getByLabel(translate("auth.password"), { exact: true }).fill("wrong-password-1");
      await failSignIns(waitEmail, 3);
      await waiting.page.getByRole("button", { name: translate("auth.signIn"), exact: true }).last().click();
      const waitAlert = waiting.page.getByRole("alert");
      await waitAlert.waitFor();
      const waitText = (await waitAlert.innerText()).trim();
      check(/^Wait [12] seconds, then try again\.$/.test(waitText), `wait message wrong at ${size}/${theme}: ${waitText}`);
      check(await noHorizontalScroll(waiting.page), `sign-in scrolls sideways with the wait message at ${size}/${theme}`);
      await waiting.page.screenshot({ path: `${shots}/wait-${size}-${theme}.png` });
      await waiting.context.close();

      // Lock: the locked account gets the right password and is still refused, with the same plain wording.
      const locking = await openSignIn(browser, size, theme);
      const lockAlertText = await submitSignIn(locking.page, lockedEmail, password);
      check(lockAlertText === lockText, `lock message wrong at ${size}/${theme}: ${lockAlertText}`);
      check(await noHorizontalScroll(locking.page), `sign-in scrolls sideways with the lock message at ${size}/${theme}`);
      await locking.page.screenshot({ path: `${shots}/lock-${size}-${theme}.png` });
      await locking.context.close();
    }
  }

  console.log("e2e sign-in-limits: ok");
  await browser.close();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const server of servers) server.kill();
  await webBuild.clean();
  const { client, db } = createDatabase();
  await db.delete(users).where(like(users.email, "e2e-%@example.test"));
  await client.end();
}
process.exit(failed ? 1 : 0);
