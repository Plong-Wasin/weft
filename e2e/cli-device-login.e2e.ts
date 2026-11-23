// The approval is completed in the browser, then the same terminal request exchanges and finalizes its credential.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31080);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52080);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const apiProc = Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api }, stdout: "inherit", stderr: "inherit" });
const webProc = Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" });

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* server is starting */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 430, height: 900 }, locale: "en-US" });
  const email = `device-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const startResponse = await fetch(`${api}/api/cli/device-authorization`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: crypto.randomUUID(), hostname: "build-host-2" }),
  });
  if (!startResponse.ok) throw new Error(`device request failed: ${startResponse.status}`);
  const started = await startResponse.json() as { deviceSecret: string; userCode: string; verificationUrl: string };

  await page.goto(started.verificationUrl);
  await page.getByText("Sign in to review this CLI device request.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByLabel("Name").fill("Device Owner");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-secure-password");
  await page.getByLabel("Confirm password").fill("a-secure-password");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("heading", { name: "Approve CLI sign-in" }).waitFor();
  await page.getByRole("definition").filter({ hasText: `${started.userCode.slice(0, 4)} ${started.userCode.slice(4)}` }).waitFor();
  await page.getByText("build-host-2", { exact: true }).waitFor();
  await page.getByText(email, { exact: false }).waitFor();
  await page.getByRole("definition").filter({ hasText: "All workspaces and account-wide CLI and Daemon access" }).waitFor();
  await page.getByText("If you did not request this sign-in, deny it.", { exact: false }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const accountNameLocator = page.getByText("Device Owner", { exact: true });
  const accountEmailLocator = page.getByText(email, { exact: true });
  if (await accountNameLocator.count() !== 1 || await accountEmailLocator.count() !== 1) throw new Error("mobile approval should expose the account name and email as separate readable lines");
  const accountName = await accountNameLocator.boundingBox();
  const accountEmail = await accountEmailLocator.boundingBox();
  if (!accountName || !accountEmail || accountEmail.y < accountName.y + accountName.height) throw new Error("mobile approval should put the account email below the account name");
  if (Bun.env.CLI_DEVICE_SCREENSHOT_DIR) {
    const directory = Bun.env.CLI_DEVICE_SCREENSHOT_DIR;
    await mkdir(directory, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      await page.screenshot({ path: `${directory}/cli-approval-pending-${width}.png`, fullPage: true });
    }
  }
  await page.getByRole("button", { name: "Approve device" }).click();
  await page.getByRole("status").filter({ hasText: "Device approved" }).waitFor();
  if (Bun.env.CLI_DEVICE_SCREENSHOT_DIR) {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      await page.screenshot({ path: `${Bun.env.CLI_DEVICE_SCREENSHOT_DIR}/cli-approval-complete-${width}.png`, fullPage: true });
    }
  }

  const poll = await fetch(`${api}/api/cli/device-authorization/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceSecret: started.deviceSecret }) });
  if ((await poll.json() as { status: string }).status !== "approved") throw new Error("terminal did not observe browser approval");
  const exchange = await fetch(`${api}/api/cli/device-authorization/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceSecret: started.deviceSecret }) });
  if (!exchange.ok) throw new Error(`credential exchange failed: ${exchange.status}`);
  const credential = await exchange.json() as { token: string; exchangeId: string };
  const finalized = await fetch(`${api}/api/cli/device-authorization/finalize`, { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" }, body: JSON.stringify({ exchangeId: credential.exchangeId }) });
  if (!finalized.ok) throw new Error(`credential finalization failed: ${finalized.status}`);
  console.log("cli-device-login ok: browser review and approval completed the terminal exchange");
} finally {
  await browser?.close();
  apiProc.kill(); webProc.kill();
}
