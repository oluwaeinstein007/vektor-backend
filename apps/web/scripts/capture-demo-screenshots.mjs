// Captures a numbered gallery of screenshots proving the dashboard +
// fusion-svc REST API work end-to-end with real sample data, into
// VEKTOR/demo-screenshots/. Re-run anytime after `pnpm dev` (apps/web) and
// fusion-svc are up — it seeds fresh entities itself so the gallery is
// never stale.
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";

const run = promisify(execFile);
const OUT_DIR = "/home/hp/Desktop/Software Projects/VEKTOR/demo-screenshots";
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

async function shot(name) {
  await page.screenshot({ path: `${OUT_DIR}/${name}` });
  console.log(`saved ${name}`);
}

// --- 1. dashboard, default global view (what you see on first load) ---
await page.goto("http://localhost:3005", { waitUntil: "networkidle" });
// the fallback demo basemap style's vector tiles are fetched from an
// external CDN and take noticeably longer than the page's own networkidle
// to actually paint (confirmed by later screenshots in this same run
// rendering fully once more time has passed) — wait for it explicitly.
await page.waitForTimeout(9000);
await shot("01-dashboard-default-view.png");

// --- 2. jump straight to the SF Bay Area (where the seed data lives) via
// the dev-only __vektorMap handle base-map.tsx exposes — simulated
// double-click/drag gestures turned out to cap out well before the zoom
// level needed to see individual entity dots. ---
await page.evaluate(() => {
  window.__vektorMap.jumpTo({ center: [-122.4, 37.85], zoom: 8 });
});
await page.waitForTimeout(1000);
await shot("02-zoomed-to-demo-region.png");

// --- 3. publish fresh sample entities while this page is connected (past
// socket.io emits never replay to a listener that connects afterward), then
// screenshot them rendering live ---
console.log("publishing fresh sample entities...");
await run("node", ["scripts/seed-demo-data.mjs"], { cwd: "../../services/fusion-svc" });
await page.waitForTimeout(4000);
await shot("03-live-entities-and-sensor-health.png");

// --- 4. toggle "No-Strike Zones" on, and zoom in closer on OUTPOST-1 (a
// 3km buffer is small relative to the whole-bay view used for the entities
// shot — too small there to actually read as a zone) ---
const zoneCheckbox = page.locator('label:has-text("No-Strike Zones") input[type=checkbox]');
await zoneCheckbox.check();
await page.evaluate(() => {
  // the fallback demo style's vector data is only detailed enough up to
  // about zoom 9-10 — past that its simplified country polygons run out
  // and the canvas goes blank, confirmed by trial.
  window.__vektorMap.jumpTo({ center: [-122.45, 37.75], zoom: 10 });
});
await page.waitForTimeout(4000);
await shot("04-no-strike-zones-visible.png");

// --- 5. fusion-svc REST API responses, as proof port 3007 is fixed ---
await page.goto("http://localhost:3007/", { waitUntil: "networkidle" });
await shot("05-fusion-svc-root-route.png");

await page.goto("http://localhost:3007/api/v1/no-strike-zones", { waitUntil: "networkidle" });
await shot("06-fusion-svc-no-strike-zones-api.png");

await page.goto("http://localhost:3007/api/v1/blue-force-assets", { waitUntil: "networkidle" });
await shot("07-fusion-svc-blue-force-assets-api.png");

await browser.close();
console.log(`done — screenshots in ${OUT_DIR}`);
