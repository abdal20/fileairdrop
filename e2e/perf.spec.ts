import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";

test.skip(!process.env.PERF, "benchmark only on demand");

async function open(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
  await page.getByTestId("open-pairing").click();
  await page.getByTestId("dev-toggle").click();
  await expect(page.getByTestId("dev-toggle")).toBeChecked();
  await page.keyboard.press("Escape");
  return page;
}

test("throughput", async ({ browser }) => {
  const a = await open(browser);
  const b = await open(browser);
  await expect(a.getByTestId("device-card")).toHaveCount(1);
  const size = 40 * 1024 * 1024;
  const results: number[] = [];
  for (let i = 0; i < 3; i++) {
    await a.getByTestId("file-input").first().setInputFiles([{ name: `f${i}.bin`, mimeType: "application/octet-stream", buffer: randomBytes(size) }]);
    await b.getByTestId("accept-transfer").click();
    const t0 = Date.now();
    await expect(a.locator('[data-testid="transfer-row"][data-status="completed"]')).toHaveCount(i + 1, { timeout: 60_000 });
    results.push(Date.now() - t0);
  }
  console.log("PERF_MBps", results.map((ms) => (size / 1048576 / (ms / 1000)).toFixed(1)).join(", "));
});
