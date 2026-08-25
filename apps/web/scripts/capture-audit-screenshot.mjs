import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("http://localhost:3009/api/v1/audit", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: "/home/hp/Desktop/Software Projects/VEKTOR/demo-screenshots/13-audit-svc-log-api.png" });
console.log("saved");
await browser.close();
