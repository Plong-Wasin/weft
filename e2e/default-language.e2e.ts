// Signed-out language follows the optional instance default and remains changeable.
import { chromium } from "playwright";
import { reviewShots } from "../tools/visual/paths";

const apiPort = Number(Bun.env.E2E_API_PORT ?? 3118);
const webPort = Number(Bun.env.E2E_WEB_PORT ?? 5218);
const api = `http://localhost:${apiPort}`;
const web = `http://localhost:${webPort}`;
const shots = reviewShots("18-default-language");
const build = Bun.spawnSync(["bunx", "vite", "build"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) throw new Error("web build failed");
const servers = [
  Bun.spawn(["bun", "apps/api/src/index.ts"], { env: { ...Bun.env, PORT: String(apiPort), WEB_ORIGIN: web, BETTER_AUTH_URL: api, DEFAULT_LANGUAGE: "th" }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite", "preview", "--port", String(webPort), "--strictPort"], { cwd: "apps/web", env: { ...Bun.env, VITE_API_URL: api }, stdout: "ignore", stderr: "inherit" }),
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
  const language = page.locator("select").first();
  await language.waitFor();
  if (await language.inputValue() !== "th") throw new Error("the signed-out language must start with the configured Thai default");
  await page.getByText("ภาษาเริ่มต้นขณะนี้: ไทย คุณเปลี่ยนได้").waitFor();
  await page.screenshot({ path: `${shots}/signed-out-thai-default.png` });
  await language.selectOption("en");
  if (await language.inputValue() !== "en") throw new Error("the signed-out user must be able to change the language");
  await page.getByText("Current default: ไทย. You can change it.").waitFor();
  console.log("e2e default-language: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
