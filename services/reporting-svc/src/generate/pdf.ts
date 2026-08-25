// SVC-020 — REQ-7.1 PDF half. puppeteer-core (not puppeteer) + the
// system's existing google-chrome binary — same pattern apps/web's
// Playwright screenshot verification already established in Phase 1/3
// (no network access needed to download a bundled Chromium, and this
// sandbox already has a real Chrome install at /usr/bin/google-chrome).
import puppeteer from "puppeteer-core";

const CHROME_PATH = process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/google-chrome";

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
