// Full-page screenshots of the home page (and the stack tab) for review.
//   node scripts/shoot-home.mjs [outDir] [url]
import path from "node:path";
const outDir = process.argv[2] || ".";
const url = process.argv[3] || "http://localhost:4317/";
const { chromium } = await import(process.env.CALLIE_PLAYWRIGHT || `${process.env.HOME}/Desktop/SayMei-Web/node_modules/playwright/index.mjs`);
const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--use-angle=metal"] });
for (const [w, h, tag] of [[1440, 900, "desk"], [390, 844, "phone"]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: tag === "phone" ? 2 : 1, reducedMotion: "reduce" }); // everything at rest for a full-page shot
  await page.goto(url);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, `home-${tag}.png`), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(tag, "horizontal overflow px:", overflow);
  if (tag === "desk") {
    await page.click('[data-tab="stack"]');
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, "stack-desk.png"), fullPage: true });
  }
  await page.close();
}
await browser.close();
