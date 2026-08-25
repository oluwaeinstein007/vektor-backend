// Screenshots proving the Keycloak realm/roles/sample-users actually work:
// the real login page, and a real post-login account console for a sample
// user — not just a curl of the token endpoint.
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const OUT_DIR = "/home/hp/Desktop/Software Projects/VEKTOR/demo-screenshots";
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

async function shot(name) {
  await page.screenshot({ path: `${OUT_DIR}/${name}` });
  console.log(`saved ${name}`);
}

// --- login page for the vektor-web client ---
await page.goto(
  "http://localhost:8080/realms/vektor/protocol/openid-connect/auth?client_id=vektor-web&response_type=code&redirect_uri=http://localhost:3005/&scope=openid",
  { waitUntil: "networkidle" },
);
await page.waitForTimeout(1000);
await shot("08-keycloak-login-page.png");

// --- actually log in as a sample Commander user, land on the real account console ---
await page.fill("#username", "cmdr.reyes");
await page.fill("#password", "VektorDemo123!");
await page.click("#kc-login");
await page.waitForTimeout(1500);
await shot("09-keycloak-login-redirect.png");

await page.goto("http://localhost:8080/realms/vektor/account/", { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await shot("10-keycloak-account-console.png");

// --- Keycloak admin console: the vektor realm's users list, roles applied ---
await page.goto("http://localhost:8080/admin/master/console/#/vektor/users", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
// log in as admin if prompted
const adminUserField = page.locator("#username");
if (await adminUserField.isVisible().catch(() => false)) {
  await page.fill("#username", "admin");
  await page.fill("#password", "VektorAdmin123!");
  await page.click("#kc-login");
  await page.waitForTimeout(2000);
}
await shot("11-keycloak-admin-users-list.png");

await browser.close();
console.log("done");
