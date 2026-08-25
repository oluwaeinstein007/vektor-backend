import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on("console", (msg) => { if (msg.type() === "error") console.log("[console error]", msg.text()); });
page.on("pageerror", (err) => console.log("[page error]", err.message));

await page.goto("https://claude.ai/code/artifact/2d0fe85d-dbc8-47a0-8d8c-59d95c50504d", { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: "/tmp/artifact-check-top.png" });
await page.evaluate(() => window.scrollTo(0, 1200));
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/artifact-check-mid.png" });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/artifact-check-bottom.png" });
console.log("done");
await browser.close();
