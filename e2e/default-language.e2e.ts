// Signed-out language follows the optional instance default and remains changeable.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
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
  const initialLanguage = (await language.textContent())?.trim();
  if (!initialLanguage?.includes("ไทย")) throw new Error(`the signed-out language must start with the configured Thai default; got ${JSON.stringify(initialLanguage)}`);
  await page.getByText("ภาษาเริ่มต้นขณะนี้: ไทย คุณเปลี่ยนได้").waitFor();
  await page.screenshot({ path: `${shots}/signed-out-thai-default.png` });
  const evidence = `${process.cwd()}/.local/shots/shadcn-02/after`;
  await mkdir(evidence, { recursive: true });
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 1180], [768, 1024], [844, 390], [667, 375], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      const box = await language.boundingBox();
      if (!box || box.left < 0 || box.right > width || box.top < 0 || box.bottom > height) throw new Error(`Language Select is clipped at ${width}x${height} (${theme}): ${JSON.stringify(box)}`);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error(`The signed-out language screen scrolls horizontally at ${width}x${height} (${theme})`);
      await page.screenshot({ path: `${evidence}/language-${width}x${height}-${theme}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 667, height: 375 });
  await language.focus();
  await page.keyboard.press("Enter");
  if (await language.getAttribute("aria-expanded") !== "true") throw new Error("Enter should open the Language Select");
  const popup = page.getByRole("listbox");
  const popupBox = await popup.boundingBox();
  if (!popupBox || popupBox.top < 0 || popupBox.bottom > 375) throw new Error(`Language options should fit the short landscape viewport: ${JSON.stringify(popupBox)}`);
  await page.keyboard.press("Escape");
  if (await language.getAttribute("aria-expanded") !== "false" || !(await language.evaluate((element) => document.activeElement === element))) throw new Error("Escape should close the Language Select and restore trigger focus");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  const englishLanguage = page.getByRole("combobox", { name: "Language" });
  if (!(await englishLanguage.textContent())?.includes("English")) throw new Error("ArrowUp and Enter should select English from the Language Select");
  await page.keyboard.press("Tab");
  if (await englishLanguage.evaluate((element) => document.activeElement === element)) throw new Error("Tab should move focus away from the Language Select");
  await englishLanguage.click();
  await page.getByRole("option", { name: "ไทย" }).click();
  if (!(await page.getByRole("combobox", { name: "ภาษา" }).textContent())?.includes("ไทย")) throw new Error("the signed-out user must be able to change the language to Thai");
  const thaiLanguage = page.getByRole("combobox", { name: "ภาษา" });
  await thaiLanguage.click();
  await page.getByRole("option", { name: "English" }).click();
  const selectedLanguage = (await englishLanguage.textContent())?.trim();
  if (!selectedLanguage?.includes("English")) throw new Error(`the signed-out user must be able to change the language; got ${JSON.stringify(selectedLanguage)}`);
  await page.getByText("Current default: ไทย. You can change it.").waitFor();
  console.log("e2e default-language: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of servers) server.kill();
}
