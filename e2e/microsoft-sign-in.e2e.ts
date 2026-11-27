import { launchBrowser, newPage, startWeb, waitFor } from "./harness";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Browser, type Page } from "playwright";
import { translate } from "../packages/shared/src";
import { saveShot } from "./shots";

const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5217);
const api = `http://localhost:${Bun.env.E2E_API_PORT ?? 3217}`;
const web = `http://localhost:${webPort}`;
const screenshotDir = Bun.env.E2E_SCREENSHOTS ?? `${tmpdir()}/weft-e2e-microsoft-sign-in`;
mkdirSync(screenshotDir, { recursive: true });
const server = startWeb(webPort, { api, host: "127.0.0.1" });

async function makePage(browser: Browser, options: { microsoftSignInEnabled: boolean; passwordSignInEnabled: boolean }, viewport: { width: number; height: number } = { width: 1440, height: 900 }) {
  const page = await newPage(browser, { viewport, locale: "en-US" });
  await page.route(`${api}/api/auth/settings`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(options) }));
  await page.route(`${api}/api/me`, (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthenticated" }) }));
  return page;
}

let browser: Browser | undefined;
let failed = false;
try {
  await waitFor(web);
  browser = await launchBrowser();

  const unchanged = await makePage(browser, { microsoftSignInEnabled: false, passwordSignInEnabled: true });
  await unchanged.goto(web);
  await unchanged.getByLabel(translate("auth.email")).waitFor();
  if (await unchanged.getByRole("button", { name: translate("auth.microsoftButton"), exact: true }).count()) throw new Error("Microsoft button must be absent when unconfigured");
  await saveShot(unchanged, { path: `${screenshotDir}/unconfigured-1440.png` });
  await unchanged.close();

  const company = await makePage(browser, { microsoftSignInEnabled: true, passwordSignInEnabled: false });
  await company.goto(web);
  await company.getByRole("button", { name: translate("auth.microsoftButton"), exact: true }).waitFor();
  if (await company.getByLabel(translate("auth.email")).count()) throw new Error("Password form must be hidden when password sign-in is disabled");
  await saveShot(company, { path: `${screenshotDir}/microsoft-en-1440.png` });
  await company.setViewportSize({ width: 390, height: 844 });
  await saveShot(company, { path: `${screenshotDir}/microsoft-en-390.png` });
  await company.goto(`${web}/?error=MICROSOFT_WRONG_TENANT`);
  await company.getByRole("alert").getByText(translate("auth.microsoftWrongTenant")).waitFor();
  await company.getByRole("combobox", { name: translate("language.label") }).click();
  await company.getByRole("option", { name: translate("language.th", "th") }).click();
  await company.getByRole("button", { name: translate("auth.microsoftButton", "th"), exact: true }).waitFor();
  await company.goto(`${web}/?error=MICROSOFT_DOMAIN_NOT_ALLOWED`);
  await company.getByRole("alert").getByText(translate("auth.microsoftDomainNotAllowed", "th")).waitFor();
  await saveShot(company, { path: `${screenshotDir}/microsoft-th-390.png` });
  await company.close();

  const invitee = await makePage(browser, { microsoftSignInEnabled: true, passwordSignInEnabled: false });
  let socialRequest: { body: Record<string, unknown>; invite: string | null } | undefined;
  await invitee.route(`${api}/api/auth/sign-in/social`, async (route) => {
    socialRequest = { body: route.request().postDataJSON() as Record<string, unknown>, invite: route.request().headers()["x-weft-invite"] ?? null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ redirect: false, url: null }) });
  });
  await invitee.goto(`${web}/invite/company-invite-token`);
  await invitee.getByText(translate("invite.signInToJoin")).waitFor();
  const socialResponse = invitee.waitForResponse((response) => response.url() === `${api}/api/auth/sign-in/social` && response.request().method() === "POST");
  await invitee.getByRole("button", { name: translate("auth.microsoftButton"), exact: true }).click();
  await socialResponse;
  if (socialRequest?.body.callbackURL !== `${web}/invite/company-invite-token`) throw new Error("Microsoft sign-in must return invitees to their invite URL");
  if (socialRequest?.invite !== "company-invite-token") throw new Error("Microsoft sign-in must send the invite token for the server-side signup gate");
  await saveShot(invitee, { path: `${screenshotDir}/microsoft-invite-1440.png` });
  await invitee.close();

  console.log("e2e microsoft-sign-in: ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await browser?.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
