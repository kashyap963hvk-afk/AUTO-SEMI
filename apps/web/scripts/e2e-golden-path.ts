/**
 * Browser end-to-end test of the golden path (spec section 40), driven through the UI.
 *   BASE_URL=http://127.0.0.1:3000 npx tsx scripts/e2e-golden-path.ts [--shots dir] [--slow]
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { goldenPath } from "./lib/goldenPath";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const shots = arg("shots");
const CHROMIUM =
  process.env.CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(240_000);
  let n = 0;
  const result = await goldenPath(page, BASE, {
    slow: process.argv.includes("--slow"),
    shot: async (name) => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, `${String(++n).padStart(2, "0")}-${name}.png`) });
    },
    caption: async () => {},
    waiting: () => {},
  });
  await browser.close();
  console.log(`downloaded ${result.download}`);
  console.log("E2E golden path: PASS");
})().catch((e) => {
  console.error("E2E golden path: FAIL", e);
  process.exit(1);
});
