// Browser flow for outbound webhooks: an Admin creates a webhook, sees its secret once, sends a test event to a local
// receiver, and sees the delivery in the log. Runs with WEFT_OUTBOUND_WEBHOOKS_ENABLED=true and private networks allowed
// (only this local receiver needs it). Run with `bun e2e/outbound-webhooks.e2e.ts` under the suite lock; set DATABASE_URL to a --keep database.
// Screenshots go to .local/visual/review/34-outbound-webhooks (or VISUAL_DIR).
import { chromium, type Page } from "playwright";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

Bun.env.WEFT_OUTBOUND_WEBHOOKS_ENABLED = "true";
Bun.env.WEFT_OUTBOUND_WEBHOOKS_ALLOW_PRIVATE_NETWORKS = "true";
const apiPort = Number(Bun.env.E2E_API_PORT ?? 31167);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 52167);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("34-outbound-webhooks");
const received: Array<{ headers: Headers; body: string }> = [];
const receiver = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch: async (request) => { received.push({ headers: request.headers, body: await request.text() }); return new Response("ok", { status: 200 }); },
});
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", colorScheme: "light" });
  const page: Page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("console:", message.text().slice(0, 400)); });
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;

  await page.goto(web);
  await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill("Webhook Admin");
  await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
  await page.getByLabel(translate("workspace.name")).fill("Webhook team");
  await page.getByLabel(translate("workspace.slug")).fill(slug);
  await page.getByRole("button", { name: translate("workspace.create") }).click();
  await page.waitForURL(new RegExp(`/${slug}`));

  await page.goto(`${web}/${slug}/settings/webhooks`);
  await page.getByRole("heading", { name: translate("outboundWebhooks.title"), level: 1 }).waitFor();
  await page.getByText(translate("outboundWebhooks.howItWorks")).waitFor();
  await page.screenshot({ path: `${shots}/webhooks-empty-1440.png`, fullPage: true });

  await page.getByLabel(translate("outboundWebhooks.name"), { exact: true }).fill("Local receiver");
  await page.getByLabel(translate("outboundWebhooks.url"), { exact: true }).fill(`http://127.0.0.1:${receiver.port}/hook`);
  await page.getByRole("button", { name: translate("outboundWebhooks.create"), exact: true }).click();
  const secretField = page.getByLabel(translate("outboundWebhooks.secretTitle"), { exact: true });
  await secretField.waitFor();
  const secret = await secretField.inputValue();
  check(/^[0-9a-f]{64}$/.test(secret), "secret was not shown once in the form");
  await page.getByRole("button", { name: translate("outboundWebhooks.test"), exact: true }).click();
  await page.getByText(/accepted the test event/).waitFor();
  await page.getByRole("cell", { name: translate("outboundWebhooks.status.succeeded"), exact: true }).waitFor();
  check(received.length === 1, `receiver got ${received.length} requests, expected 1`);
  const request = received[0]!;
  check(request.headers.get("x-weft-event") === "webhook.test", "event header missing");
  check(typeof request.headers.get("x-weft-delivery") === "string", "delivery id header missing");
  await page.screenshot({ path: `${shots}/webhooks-tested-1440.png`, fullPage: true });

  // Reloading shows the webhook and its log, but never the secret again.
  await page.reload();
  await page.getByRole("heading", { name: "Local receiver", level: 2 }).waitFor();
  check(await page.getByLabel(translate("outboundWebhooks.secretTitle"), { exact: true }).count() === 0, "secret shown again after reload");
  await page.setViewportSize({ width: 390, height: 844 });
  // Baseline: the General settings page of the same workspace, at the same width.
  await page.goto(`${web}/${slug}/settings`);
  await page.getByRole("heading", { name: translate("settings.workspaceTitle") }).waitFor();
  console.log("baseline general settings width:", await page.evaluate(() => document.documentElement.scrollWidth));
  await page.goto(`${web}/${slug}/settings/webhooks`);
  await page.getByRole("heading", { name: translate("outboundWebhooks.title"), level: 1 }).waitFor();
  await page.getByRole("heading", { name: "Local receiver", level: 2 }).waitFor();
  await page.screenshot({ path: `${shots}/webhooks-390.png`, fullPage: true });
  // The table scrolls inside its own box; the page itself must not scroll sideways.
  const pageWidth = await page.evaluate(() => {
    const wide = [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 8).map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)}=${Math.round(element.getBoundingClientRect().right)}`);
    return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, wide };
  });
  check(pageWidth.scroll <= pageWidth.inner, `the page scrolls sideways at phone width: ${JSON.stringify(pageWidth)}`);
  await browser.close();
  console.log("outbound webhooks flow ok");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  receiver.stop(true);
  for (const server of servers) server.kill();
}
process.exit(failed ? 1 : 0);
