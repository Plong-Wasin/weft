// Browser end-to-end flow: API tokens inside the app shell. The screen has the settings navigation and links to Connect AI,
// presets fill the name and the 30-day expiry, a new token is shown once with a copy button and a warning, and it is gone after closing.
// Run with `bun e2e/api-tokens.e2e.ts` (set DATABASE_URL, E2E_API_PORT, E2E_WEB_PORT, CHROMIUM_PATH as in docs/agents/testing.md).
// Screenshots go to the review folder for this ticket (reviewShots("api-tokens")).
import { check, createSignedInContext, launchBrowser, startApi, startWeb, waitFor } from "./harness";
import { SQL } from "bun";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";
import { saveShot } from "./shots";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 31080);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52080);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("api-tokens");

const apiProc = startApi(apiPort, web);
const webProc = startWeb(webPort, { api });

/** The expiry a preset fills in: 30 days from today, as YYYY-MM-DD in local time. */
function thirtyDaysOut() {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

let failed = false;
try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await launchBrowser();
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const context = await createSignedInContext(browser, { viewport: { width: 1440, height: 900 }, locale: "en-US", colorScheme: "light" }, api, web, {
    account: { name: "Token Admin", email: `${slug}@example.test` },
    workspace: { name: "Token team", slug },
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: web });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  const sidebar = page.getByRole("navigation", { name: translate("shell.sidebar") });

  await page.goto(`${web}/${slug}`);
  await page.waitForURL(`${web}/${slug}**`);

  // The old account URL opens the screen inside the workspace shell, with the settings navigation.
  await page.goto(`${web}/account/api-tokens`);
  await page.waitForURL(`${web}/${slug}/settings/api-tokens`);
  await page.getByRole("heading", { name: translate("tokens.title"), exact: true }).waitFor();
  await page.getByRole("heading", { name: translate("devices.title"), exact: true }).waitFor();
  await page.getByRole("heading", { name: translate("tokens.activeTitle"), exact: true }).waitFor();
  check(await sidebar.getByRole("link", { name: translate("tokens.title"), exact: true }).getAttribute("aria-current") === "page", "API tokens is not the current sidebar item");
  check(await page.getByRole("link", { name: translate("tokens.connectAiLink") }).getAttribute("href") === `/${slug}/settings/connect-ai`, "Connect AI link is missing or wrong");
  console.log("api-tokens ok: shell navigation and Connect AI link");

  // Going back: the sidebar leads to Connect AI and back again.
  await sidebar.getByRole("link", { name: translate("settings.connectAi"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings/connect-ai`);
  await sidebar.getByRole("link", { name: translate("tokens.title"), exact: true }).click();
  await page.waitForURL(`${web}/${slug}/settings/api-tokens`);
  console.log("api-tokens ok: way back via navigation");

  await saveShot(page, { path: `${shots}/list-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await saveShot(page, { path: `${shots}/list-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Empty groups explain what is managed here.
  await page.getByText(translate("devices.empty")).waitFor();
  await page.getByText(translate("tokens.personalEmpty")).waitFor();
  await page.getByText(translate("apps.empty")).waitFor();

  // Seed inactive credentials through the session actions, plus one unassociated legacy Daemon credential.
  const seeded = await page.evaluate(async (apiOrigin) => {
    const request = async (name: string, body: unknown) => {
      const response = await fetch(`${apiOrigin}/actions/${name}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`${name} failed: ${response.status}`);
      return await response.json() as { id: string };
    };
    for (let index = 0; index < 21; index += 1) {
      const token = await request("create_api_token", { name: `History ${String(index).padStart(2, "0")}` });
      await request("revoke_api_token", { tokenId: token.id });
    }
    const nonExpiring = await request("create_api_token", { name: "Non-expiring credential" });
    const legacy = await request("create_api_token", { name: "Legacy Daemon" });
    return { legacyId: legacy.id, nonExpiringId: nonExpiring.id };
  }, api);
  const database = new SQL(Bun.env.DATABASE_URL!);
  try { await database`update api_tokens set daemon_only = true where id = ${seeded.legacyId}`; }
  finally { await database.close(); }
  await page.reload();
  const nonExpiringRow = page.getByRole("listitem").filter({ hasText: "Non-expiring credential" });
  await nonExpiringRow.waitFor();
  check((await nonExpiringRow.innerText()).includes(translate("tokens.never")), "a non-expiring Personal API token is not clearly identified");
  check((await nonExpiringRow.innerText()).includes(translate("tokens.notUsed")), "an unused Personal API token does not explain its last activity");
  const legacyRow = page.getByRole("listitem").filter({ hasText: "Legacy Daemon" });
  await legacyRow.getByRole("button", { name: translate("tokens.revoke"), exact: true }).waitFor();
  check(await legacyRow.count() === 1, "the unassociated legacy Daemon credential is not shown once in account settings");
  page.once("dialog", (confirm) => void confirm.accept());
  await legacyRow.getByRole("button", { name: translate("tokens.revoke"), exact: true }).click();
  const tokenHistorySummary = translate("tokens.history").replace("{count}", "22");
  const tokenHistory = page.locator("details").filter({ has: page.getByText(tokenHistorySummary, { exact: true }) });
  await tokenHistory.waitFor();
  check(await tokenHistory.getAttribute("open") === null, "credential history is expanded by default");
  await tokenHistory.locator("summary").click();
  check(await tokenHistory.getByRole("listitem").count() === 20, "credential history did not start with a bounded 20-record page");
  await tokenHistory.getByRole("button", { name: translate("tokens.loadMore"), exact: true }).click();
  await tokenHistory.getByRole("listitem").nth(21).waitFor();
  check(await tokenHistory.getByRole("listitem").count() === 22, "loading more credentials did not append the remaining history records");
  check(await tokenHistory.getByTestId("credential-history-status").count() === 22, "credential history omitted status labels");
  check((await tokenHistory.getByRole("listitem").filter({ hasText: "Legacy Daemon" }).innerText()).includes(translate("tokens.revokedAt")), "revoked credential history does not identify its relevant date");
  await saveShot(page, { path: `${shots}/history-paged-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await saveShot(page, { path: `${shots}/history-paged-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("api-tokens ok: legacy credentials remain revocable and inactive history loads in bounded pages");

  // Enroll a device through the same authorization exchange as a remote CLI, then verify account settings can identify and revoke it.
  const enrolled = await page.evaluate(async (apiOrigin) => {
    const request = async (url: string, init?: RequestInit) => fetch(`${apiOrigin}${url}`, { credentials: "include", ...init });
    const started = await request("/api/cli/device-authorization", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: crypto.randomUUID(), hostname: "E2E Workstation" }) });
    if (!started.ok) throw new Error(`device authorization start failed: ${started.status}`);
    const authorization = await started.json() as { deviceSecret: string; userCode: string };
    const reviewed = await request(`/api/cli/device-authorization?code=${encodeURIComponent(authorization.userCode)}`);
    if (!reviewed.ok) throw new Error(`device authorization review failed: ${reviewed.status}`);
    const decided = await request("/api/cli/device-authorization/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: authorization.userCode, decision: "approve" }) });
    if (!decided.ok) throw new Error(`device authorization approval failed: ${decided.status}`);
    const exchanged = await request("/api/cli/device-authorization/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceSecret: authorization.deviceSecret }) });
    if (!exchanged.ok) throw new Error(`device authorization exchange failed: ${exchanged.status}`);
    const credential = await exchanged.json() as { token: string; exchangeId: string };
    const finalized = await request("/api/cli/device-authorization/finalize", { method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" }, body: JSON.stringify({ exchangeId: credential.exchangeId }) });
    if (!finalized.ok) throw new Error(`device authorization finalize failed: ${finalized.status}`);
    return true;
  }, api);
  check(enrolled, "could not enroll the browser-flow CLI device");
  await page.reload();
  const deviceRow = page.getByRole("listitem").filter({ hasText: "E2E Workstation" });
  await deviceRow.getByText("E2E Workstation").waitFor();
  check(await deviceRow.getByText("E2E Workstation").count() === 1, "device row is missing or duplicated");
  check((await deviceRow.innerText()).includes(translate("devices.lastActivity")), "an active CLI device does not show its last activity");
  await saveShot(page, { path: `${shots}/device-list-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await saveShot(page, { path: `${shots}/device-list-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  page.once("dialog", (confirm) => void confirm.accept());
  await deviceRow.getByRole("button", { name: translate("devices.revoke"), exact: true }).click();
  await page.getByText(translate("devices.history").replace("{count}", "1")).click();
  await page.getByRole("listitem").filter({ hasText: "E2E Workstation" }).getByTestId("device-history-status").getByText(translate("devices.status.revoked"), { exact: true }).waitFor();
  await saveShot(page, { path: `${shots}/device-revoked-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await saveShot(page, { path: `${shots}/device-revoked-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("api-tokens ok: device listed and revoked from account settings");

  // Presets: MCP is the default and fills the name and a 30-day expiry; CLI fills its own name; Custom keeps the typed values.
  await page.getByRole("button", { name: translate("tokens.add"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  const preset = dialog.getByLabel(translate("tokens.presetLabel"));
  const name = dialog.getByLabel(translate("tokens.name"));
  const expiry = dialog.getByLabel(translate("tokens.customDate"));
  check(await preset.inputValue() === "mcp", "default preset is not MCP");
  check(await name.inputValue() === "MCP", `MCP preset did not fill the name: ${await name.inputValue()}`);
  check(await expiry.inputValue() === thirtyDaysOut(), `default expiry is ${await expiry.inputValue()}, not 30 days out`);
  await preset.selectOption("cli");
  check(await name.inputValue() === "CLI", "CLI preset did not fill the name");
  check(await expiry.inputValue() === thirtyDaysOut(), "CLI preset changed the 30-day expiry");
  await preset.selectOption("custom");
  check(await name.inputValue() === "CLI", "Custom preset cleared the typed name");
  await name.fill("Laptop");
  await expiry.fill("2031-06-15");
  await preset.selectOption("mcp");
  check(await name.inputValue() === "MCP" && await expiry.inputValue() === thirtyDaysOut(), "MCP preset did not refill name and expiry");
  await saveShot(page, { path: `${shots}/create-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await saveShot(page, { path: `${shots}/create-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("api-tokens ok: presets fill name and 30-day expiry");

  // Create: the token is shown once, with a large copy button and a warning.
  await dialog.getByRole("button", { name: translate("tokens.create"), exact: true }).click();
  const secretInput = dialog.getByLabel(translate("tokens.secret"));
  await secretInput.waitFor();
  const secret = await secretInput.inputValue();
  check(secret.length > 0, "no token shown after create");
  await dialog.getByText(translate("tokens.secretWarning")).waitFor();
  const copy = dialog.getByRole("button", { name: translate("tokens.copy"), exact: true });
  const box = await copy.boundingBox();
  check(box !== null && box.height >= 44, `copy button is not large: ${box?.height}px`);
  await copy.click();
  await page.getByRole("status").getByText(translate("tokens.copied")).last().waitFor();
  check(await page.evaluate(() => navigator.clipboard.readText()) === secret, "copy did not put the token on the clipboard");
  await saveShot(page, { path: `${shots}/secret-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await saveShot(page, { path: `${shots}/secret-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log("api-tokens ok: token shown once with copy button and warning");

  // Closing the dialog hides the token for good: it is not in the dialog again, nor on the page.
  await dialog.getByRole("button", { name: translate("settings.cancel"), exact: true }).last().click();
  await dialog.waitFor({ state: "detached" });
  check(await page.getByText(secret).count() === 0, "token text is still on the page after closing");
  await page.getByRole("button", { name: translate("tokens.add"), exact: true }).click();
  check(await dialog.getByLabel(translate("tokens.secret")).count() === 0, "token shown again after reopening");
  check(await dialog.getByLabel(translate("tokens.name")).inputValue() === "MCP", "reopened form kept old values");
  await dialog.getByRole("button", { name: translate("settings.cancel"), exact: true }).first().click();
  await dialog.waitFor({ state: "detached" });
  console.log("api-tokens ok: token not shown again after closing");

  // The new token is listed under Personal API tokens and moves into collapsed history when revoked.
  const tokenRow = page.getByRole("listitem").filter({ hasText: "MCP" });
  await tokenRow.getByText("MCP").waitFor();
  page.once("dialog", (confirm) => void confirm.accept());
  await tokenRow.getByRole("button", { name: translate("tokens.revoke"), exact: true }).click();
  await page.getByText(translate("tokens.history").replace("{count}", "23")).click();
  await page.getByRole("listitem").filter({ hasText: "MCP" }).getByTestId("credential-history-status").getByText(translate("tokens.status.revoked"), { exact: true }).waitFor();
  await saveShot(page, { path: `${shots}/revoked-1440.png` });
  await page.setViewportSize({ width: 390, height: 900 });
  await saveShot(page, { path: `${shots}/revoked-390.png` });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "side scroll at 390px");
  await browser.close();
  console.log("api-tokens flow ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  apiProc.kill();
  webProc.kill();
  await Promise.allSettled([apiProc.exited, webProc.exited]);
}
process.exit(failed ? 1 : 0);
