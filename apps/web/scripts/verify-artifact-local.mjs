import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on("console", (msg) => { if (msg.type() === "error") console.log("[console error]", msg.text()); });
page.on("pageerror", (err) => console.log("[page error]", err.message));

const path = "file:///tmp/claude-1000/-home-hp-Desktop-Software-Projects-VEKTOR/e94b1bed-ca1a-4ed1-9eef-883b435956f2/scratchpad/vektor-overview.html";
await page.goto(path, { waitUntil: "networkidle", timeout: 20000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/artifact-local-top.png" });
await page.evaluate(() => window.scrollTo(0, 1300));
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/artifact-local-mid1.png" });
await page.evaluate(() => window.scrollTo(0, 2900));
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/artifact-local-mid2.png" });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/artifact-local-bottom.png" });
console.log("done, page height:", await page.evaluate(() => document.body.scrollHeight));
await browser.close();
