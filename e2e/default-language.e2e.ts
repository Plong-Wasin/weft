// Signed-out language follows the optional instance default and remains changeable.
import { chromium } from "playwright";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3118);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5218);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("18-default-language");
// The dev server, not a build served by `vite preview`: a build writes apps/web/dist, which flows running side by side would overwrite under each other.
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api, DEFAULT_LANGUAGE: "th" }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
];

async function waitFor(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* waiting for the local app */ }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not start`);
}

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await Promise.all([waitFor(`${api}/api/config`), waitFor(web)]);
  browser = await chromium.launch({ executablePath: Bun.env.CHROMIUM_PATH });
  const page = await browser.newPage({ locale: "en-US" });
  await page.goto(web);
  // The language control is a shadcn Select (combobox trigger + listbox), not a native select.
  const language = page.getByRole("combobox", { name: "Language" }).or(page.getByRole("combobox", { name: "ภาษา" }));
  await language.waitFor();
  if ((await language.textContent())?.trim() !== "ไทย") throw new Error("the signed-out language must start with the configured Thai default");
  await page.getByText("ภาษาเริ่มต้นขณะนี้: ไทย คุณเปลี่ยนได้").waitFor();
  await page.screenshot({ path: `${shots}/signed-out-thai-default.png` });
  await language.click();
  await page.getByRole("option", { name: "English" }).click();
  if ((await language.textContent())?.trim() !== "English") throw new Error("the signed-out user must be able to change the language");
  await page.getByText("Current default: ไทย. You can change it.").waitFor();
  console.log("e2e default-language: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
