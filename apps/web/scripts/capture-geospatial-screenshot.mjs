import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("http://localhost:3010/api/v1/entities?limit=10", { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: "/home/hp/Desktop/Software Projects/VEKTOR/demo-screenshots/12-geospatial-svc-entities-api.png" });
console.log("saved");
await browser.close();
