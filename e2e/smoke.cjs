// Drives the installed app: node e2e/smoke.cjs <windows|android> <add|verify|backup|update|updated> [screenshot]
// playwright-core is installed outside the project (PW_DIR) so the lockfile is untouched.
const fs = require("node:fs");
const path = require("node:path");
const { chromium, _android } = require(path.join(process.env.PW_DIR, "node_modules", "playwright-core"));

const [platform, phase, shot] = process.argv.slice(2);
const SKU = "SMOKE-BP-1";

async function openPage() {
  if (platform === "android") {
    const [device] = await _android.devices();
    if (!device) throw new Error("No Android device found");
    const view = await device.webView({ pkg: "com.akhtar.autos.desktop" }, { timeout: 90000 });
    return { page: await view.page(), close: () => device.close() };
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
      const page = browser.contexts()[0].pages()[0];
      if (!page) throw new Error("No app window yet");
      return { page, close: () => browser.close() };
    } catch (error) {
      if (attempt >= 60) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

(async () => {
  const { page, close } = await openPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.getByRole("button", { name: "Inventory" }).click({ timeout: 90000 });
    if (phase === "add") {
      await page.getByRole("button", { name: "Add item" }).click();
      for (const answer of ["Smoke brake pad", SKU, "1000", "2000", "5"]) {
        const input = page.locator('input[type="text"]').last();
        const ok = page.locator('[data-act="ok"]');
        await ok.waitFor();
        await input.fill(answer);
        await ok.click();
      }
    }
    await page.getByText(SKU).first().waitFor({ timeout: 20000 });
    if (phase === "backup") {
      await page.getByRole("button", { name: /^settings$/i }).click();
      const pending = page.waitForEvent("download", { timeout: 30000 });
      await page.getByRole("button", { name: "Download backup" }).click();
      const target = path.join(process.env.RUNNER_TEMP || ".", "smoke-backup.json");
      await (await pending).saveAs(target);
      const backup = JSON.parse(fs.readFileSync(target, "utf8"));
      if (!backup.items.some((i) => i.sku === SKU)) throw new Error("Backup does not contain the item");
    }
    if (phase === "update") {
      // The banner appears by itself; the app closes while the installer runs.
      await page.getByRole("button", { name: "Abhi update karein" }).click({ timeout: 60000 });
      await page.waitForEvent("close", { timeout: 180000 });
    }
    if (phase === "updated") {
      const expected = process.env.EXPECTED_VERSION;
      await page.getByRole("button", { name: /^settings$/i }).click();
      await page.getByText(`Installed version: ${expected}`).waitFor({ timeout: 30000 });
    }
    if (errors.length) throw new Error("Page errors: " + errors.join(" | "));
    console.log(`SMOKE PASS ${platform} ${phase}`);
  } finally {
    if (shot) await page.screenshot({ path: shot }).catch(() => {});
    await close().catch(() => {});
  }
})().catch((error) => {
  console.error(`SMOKE FAIL ${platform} ${phase}: ${error.message}`);
  process.exit(1);
});
