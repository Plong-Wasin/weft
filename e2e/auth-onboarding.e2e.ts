// Browser end-to-end flow: restyled auth and onboarding screens keep their flows. Runs with open signup OFF so the
// first-user rule and the invite exception are exercised. Needs an empty instance (set DATABASE_URL to your own database).
// Screenshots at 1440px and 390px land in .local/visual/review/04-auth-onboarding/.
import { chromium, type Browser, type Page } from "playwright";
import { like } from "drizzle-orm";
import { createDatabase, users, workspaces } from "../packages/db/src";
import { translate } from "../packages/shared/src";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3109);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5209);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("04-auth-onboarding");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api, ALLOW_SIGNUP: "false" }, stdout: "inherit", stderr: "inherit" }),
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
const sizes = { "1440": { width: 1440, height: 900 }, "390": { width: 390, height: 844 } } as const;
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function freshPage(browser: Browser, size: keyof typeof sizes = "1440") {
  const context = await browser.newContext({ viewport: sizes[size], locale: "en-US", colorScheme: "light" });
  return { context, page: await context.newPage() };
}

async function signUp(page: Page, name: string, email: string) {
  // Sign in is the default view; an invite link opens on sign-up already.
  await page.getByLabel(translate("auth.email")).waitFor();
  if (await page.getByLabel(translate("auth.name")).count() === 0) await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
  await page.getByLabel(translate("auth.name")).fill(name);
  await page.getByLabel(translate("auth.email")).fill(email);
  await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
  if (await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).count()) await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
  await page.getByRole("button", { name: translate("auth.signUp") }).click();
}

let failed = false;

try {
  await Promise.all([waitFor(`${api}/api/me`), waitFor(web)]);
  const browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const slug = `e2e-${crypto.randomUUID().slice(0, 8)}`;

  // Auth layout: logo + live "weft" text top left, link to the other mode top right, centred column; at both widths.
  for (const size of Object.keys(sizes) as Array<keyof typeof sizes>) {
    const { context, page } = await freshPage(browser, size);
    await page.goto(web);
    await page.getByRole("heading", { name: new RegExp(translate("app.welcome")) }).waitFor();
    check(await page.getByText(translate("auth.welcomeBack")).isVisible(), "sign-in must be the default view");
    check(await page.getByLabel(translate("auth.name")).count() === 0, "sign-in must not ask for a name");
    check(await page.getByText(translate("auth.needAccountShort")).isVisible(), "header mode link missing");
    await page.screenshot({ path: `${shots}/sign-in-${size}.png` });
    await page.getByRole("button", { name: translate("auth.signUp"), exact: true }).click();
    await page.getByText(translate("auth.createYourAccount")).waitFor();
    check(await page.locator("header img[src='/brand/weft-mark.png']").isVisible(), "logo mark missing");
    check(await page.locator("header").getByText(translate("app.title"), { exact: true }).isVisible(), "weft wordmark text missing");
    check(await page.getByText(translate("auth.haveAccountShort")).isVisible(), "sign-up header mode link missing");
    check(await noHorizontalScroll(page), `sign-up scrolls sideways at ${size}`);
    const form = await page.locator("form").boundingBox();
    check(Boolean(form) && Math.abs(form!.x + form!.width / 2 - sizes[size].width / 2) < 2, `form not centred at ${size}`);
    // Confirm password: a mismatch blocks submit with an inline message; the eye button reveals both fields.
    const password = page.getByLabel(translate("auth.password"), { exact: true });
    const confirm = page.getByLabel(translate("auth.confirmPassword"), { exact: true });
    await password.fill("a-secure-password");
    await confirm.fill("a-different-password");
    check(await page.getByText(translate("auth.passwordMismatch")).first().isVisible(), "mismatch message missing");
    check(await confirm.getAttribute("aria-invalid") === "true", "confirm field must be aria-invalid on mismatch");
    check(await password.getAttribute("type") === "password" && await confirm.getAttribute("type") === "password", "passwords must start hidden");
    await page.getByRole("button", { name: translate("auth.showPassword") }).first().click();
    check(await password.getAttribute("type") === "text" && await confirm.getAttribute("type") === "text", "show toggle must reveal both fields");
    await page.getByRole("button", { name: translate("auth.hidePassword") }).first().click();
    check(await password.getAttribute("type") === "password", "hide toggle must hide the field");
    await confirm.fill("a-secure-password");
    check(await page.getByText(translate("auth.passwordMismatch")).count() === 0, "mismatch message must clear when passwords match");
    await page.screenshot({ path: `${shots}/sign-up-${size}.png` });
    await context.close();
  }

  // Thai: the same screen reads in Thai.
  {
    const { context, page } = await freshPage(browser);
    await page.goto(web);
    await page.getByLabel(translate("language.label")).selectOption("th");
    await page.getByRole("button", { name: translate("auth.signUp", "th"), exact: true }).click();
    await page.getByRole("heading").getByText("สร้างบัญชี Weft ของคุณ").waitFor();
    check(await page.getByRole("button", { name: "สร้างบัญชี" }).isVisible(), "Thai submit button missing");
    await page.screenshot({ path: `${shots}/sign-up-th-1440.png` });
    await context.close();
  }

  // First-user rule: open signup is off, yet the very first account may sign up, then create the first workspace.
  const admin = await freshPage(browser);
  await admin.page.goto(web);
  await signUp(admin.page, "First Admin", `${slug}@example.test`);
  await admin.page.getByRole("heading", { name: translate("workspace.firstTitle") }).waitFor();
  check(await admin.page.getByText(translate("auth.signOut")).isVisible(), "sign out action missing on onboarding");
  check(await noHorizontalScroll(admin.page), "first-workspace screen scrolls sideways at 1440");
  await admin.page.screenshot({ path: `${shots}/create-workspace-1440.png` });
  await admin.page.setViewportSize(sizes["390"]);
  check(await noHorizontalScroll(admin.page), "first-workspace screen scrolls sideways at 390");
  await admin.page.screenshot({ path: `${shots}/create-workspace-390.png` });
  await admin.page.setViewportSize(sizes["1440"]);
  await admin.page.getByLabel(translate("workspace.name")).fill("E2E team");
  await admin.page.getByLabel(translate("workspace.slug")).fill(slug);
  await admin.page.getByRole("button", { name: translate("workspace.create") }).click();
  await admin.page.waitForURL(`${web}/${slug}`);

  // With a workspace in place and open signup off, a stranger cannot sign up: same error message as before.
  const stranger = await freshPage(browser);
  await stranger.page.goto(web);
  await signUp(stranger.page, "Stranger", `${slug}-stranger@example.test`);
  await stranger.page.getByRole("alert").getByText(translate("auth.signUpFailed")).waitFor();
  await stranger.context.close();

  // Invite flow: admin makes a link; the invitee opens it, signs up despite closed signup, and lands in the workspace.
  await admin.page.goto(`${web}/${slug}/settings/invites`);
  await admin.page.getByRole("button", { name: translate("invite.create") }).click();
  const link = await admin.page.locator("input[readonly]").inputValue();
  check(link.startsWith(`${web}/invite/`), `invite link is ${link}`);
  for (const size of Object.keys(sizes) as Array<keyof typeof sizes>) {
    const invitee = await freshPage(browser, size);
    await invitee.page.goto(link);
    await invitee.page.getByRole("status").getByText(translate("invite.signInToJoin")).waitFor();
    check(await noHorizontalScroll(invitee.page), `invite sign-up scrolls sideways at ${size}`);
    await invitee.page.screenshot({ path: `${shots}/invite-sign-up-${size}.png` });
    if (size === "1440") {
      await signUp(invitee.page, "Invited Person", `${slug}-invited@example.test`);
      await invitee.page.waitForURL(`${web}/${slug}`);
      await invitee.page.getByRole("heading", { name: translate("projects.title") }).waitFor();
    }
    await invitee.context.close();
  }

  // A used-up or bogus link shows the same error message on the restyled screen.
  {
    const { context, page } = await freshPage(browser);
    await page.goto(web);
    await page.getByLabel(translate("auth.email")).fill(`${slug}@example.test`);
    await page.getByLabel(translate("auth.password"), { exact: true }).fill("a-secure-password");
    if (await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).count()) await page.getByLabel(translate("auth.confirmPassword"), { exact: true }).fill("a-secure-password");
    await page.getByRole("button", { name: translate("auth.signIn"), exact: true }).last().click();
    await page.getByRole("heading", { name: translate("projects.title") }).waitFor();
    await page.goto(`${web}/invite/not-a-real-token`);
    await page.getByRole("alert").getByText(translate("invite.failed")).waitFor();
    await page.screenshot({ path: `${shots}/invite-invalid-1440.png` });
    await context.close();
  }

  console.log("e2e auth-onboarding: ok");
  await browser.close();
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
