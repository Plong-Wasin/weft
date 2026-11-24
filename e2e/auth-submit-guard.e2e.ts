// Browser regression coverage for auth submits: same-turn duplicates, failure recovery and mode stability.
import { chromium, type Page, type Route } from "playwright";
import { rm } from "node:fs/promises";
import { translate } from "../packages/shared/src";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3119);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5219);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const webDist = `/tmp/weft-auth-submit-guard-${crypto.randomUUID()}`;
const webBuild = Bun.spawnSync(["bunx", "vite", "build", "--outDir", webDist, "--emptyOutDir"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" });
if (webBuild.exitCode !== 0) throw new Error("web build failed");
const apiProc = Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" });
const webProc = Bun.spawn(["bunx", "vite", "preview", "--outDir", webDist, "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env }, stdout: "ignore", stderr: "inherit" });

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* server is starting */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

/** Holds auth requests until the browser has had a chance to submit twice in one JS turn. */
function holdRequests(page: Page, path: string) {
  let count = 0;
  const releases: Array<() => void> = [];
  const responses: Array<{ status: number; body: Record<string, unknown> }> = [];
  const route = page.route(`${api}${path}`, async (requestRoute: Route) => {
    count += 1;
    await new Promise<void>((resolve) => releases.push(resolve));
    const response = responses.shift();
    if (!response) throw new Error(`No response queued for ${path}`);
    await requestRoute.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
  });

  return {
    route,
    get count() { return count; },
    async waitForCount(expected: number) {
      for (let attempt = 0; attempt < 100 && count < expected; attempt += 1) await Bun.sleep(10);
      check(count === expected, `${path}: expected ${expected} request(s), got ${count}`);
    },
    respond(status: number, body: Record<string, unknown> = {}) {
      const release = releases.shift();
      check(release !== undefined, `${path}: no pending request to answer`);
      responses.push({ status, body });
      release!();
    },
  };
}

async function dispatchTwoSubmitsInOneTurn(page: Page) {
  await page.evaluate(() => {
    const form = document.querySelector("form");
    if (!form) throw new Error("auth form missing");
    const event = () => new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event());
    form.dispatchEvent(event());
  });
}

async function dispatchClick(page: Page, buttonName: string) {
  await page.getByRole("button", { name: buttonName, exact: true }).evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function waitForBusy(page: Page, expected: string) {
  await page.waitForFunction((value) => document.querySelector("form")?.getAttribute("aria-busy") === value, expected);
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await Promise.all([waitFor(`${api}/api/health/live`), waitFor(web)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  await page.route(`${api}/api/config`, async (route) => {
    const response = await route.fetch();
    const config = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...config, emailEnabled: true } });
  });
  await page.goto(web);
  await page.getByLabel(translate("auth.email")).waitFor();

  // Sign-in: React state does not synchronously close the same-render submit window.
  const signIn = holdRequests(page, "/api/auth/sign-in/email");
  await page.getByLabel(translate("auth.email")).fill("signin@example.test");
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await dispatchTwoSubmitsInOneTurn(page);
  await signIn.waitForCount(1);
  await waitForBusy(page, "true");
  check(await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).isDisabled(), "sign-in mode switch must be disabled while pending");
  check(await page.getByRole("button", { name: translate("auth.forgotPassword") }).isDisabled(), "forgot-password switch must be disabled while sign-in is pending");
  await dispatchClick(page, translate("auth.signUp"));
  check(await page.getByLabel(translate("auth.name")).count() === 0, "a forced mode-switch event must not change screens while sign-in is pending");
  signIn.respond(401, { code: "INVALID_EMAIL_OR_PASSWORD" });
  await page.getByRole("alert").waitFor();
  await waitForBusy(page, "false");
  check(await page.getByRole("button", { name: translate("auth.signIn"), exact: true }).isEnabled(), "sign-in must re-enable after a failed request");
  await page.getByRole("button", { name: translate("auth.signIn"), exact: true }).click();
  await signIn.waitForCount(2);
  signIn.respond(200, {});
  await waitForBusy(page, "false");
  check(await page.getByRole("alert").count() === 0, "successful sign-in retry must clear the prior error");
  await signIn.route;

  // Sign-up: the same latch and mode lock cover account creation.
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  const signUp = holdRequests(page, "/api/auth/sign-up/email");
  await page.getByLabel(translate("auth.name")).fill("Signup Tester");
  await page.getByLabel(translate("auth.email")).fill("signup@example.test");
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await dispatchTwoSubmitsInOneTurn(page);
  await signUp.waitForCount(1);
  await waitForBusy(page, "true");
  check(await page.getByRole("button", { name: translate("auth.signIn"), exact: true }).isDisabled(), "sign-up mode switch must be disabled while pending");
  await dispatchClick(page, translate("auth.signIn"));
  check(await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).isVisible(), "a forced mode-switch event must not change screens while sign-up is pending");
  signUp.respond(400, { code: "SIGN_UP_FAILED" });
  await page.getByRole("alert").waitFor();
  await waitForBusy(page, "false");
  check(await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).isEnabled(), "sign-up must re-enable after a failed request");
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await signUp.waitForCount(2);
  signUp.respond(200, {});
  await waitForBusy(page, "false");
  check(await page.getByRole("alert").count() === 0, "successful sign-up retry must clear the prior error");
  await signUp.route;

  // Password reset: failure leaves the form usable and back navigation cannot switch screens mid-request.
  await page.getByRole("button", { name: translate("auth.signIn"), exact: true }).click();
  await page.getByRole("button", { name: translate("auth.forgotPassword") }).click();
  await page.getByRole("heading", { name: translate("auth.forgotTitle") }).waitFor();
  const reset = holdRequests(page, "/api/auth/request-password-reset");
  await page.getByLabel(translate("auth.email")).fill("reset@example.test");
  await dispatchTwoSubmitsInOneTurn(page);
  await reset.waitForCount(1);
  await waitForBusy(page, "true");
  check(await page.getByRole("button", { name: translate("auth.backToSignIn") }).isDisabled(), "reset back button must be disabled while pending");
  await dispatchClick(page, translate("auth.backToSignIn"));
  check(await page.getByRole("heading", { name: translate("auth.forgotTitle") }).isVisible(), "a forced back event must not leave reset while its request is pending");
  reset.respond(500, {});
  await page.getByRole("alert").waitFor();
  await waitForBusy(page, "false");
  check(await page.getByRole("button", { name: translate("auth.forgotSubmit") }).isEnabled(), "password reset must re-enable after a failed request");
  await page.getByRole("button", { name: translate("auth.forgotSubmit") }).click();
  await reset.waitForCount(2);
  reset.respond(200, {});
  await page.getByRole("status").getByText(translate("auth.forgotSent")).waitFor();
  await reset.route;

  console.log("e2e auth-submit-guard: same-turn submits deduplicated; sign-in, sign-up and reset recover after failure; mode controls stay locked while pending");
} finally {
  await browser?.close();
  apiProc.kill();
  webProc.kill();
  await rm(webDist, { recursive: true, force: true });
}
