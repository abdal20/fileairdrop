import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Download, type Page } from "@playwright/test";

const instrument = () => {
  const w = window as unknown as Record<string, number>;
  w.__binarySent = 0;
  w.__binaryReceived = 0;
  w.__readDelay = 0;
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: string | ArrayBuffer | ArrayBufferView | Blob) {
    if (typeof data !== "string") w.__binarySent += (data as ArrayBuffer).byteLength ?? 0;
    return send.call(this, data as never);
  } as typeof send;
  const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, "onmessage")!;
  Object.defineProperty(RTCDataChannel.prototype, "onmessage", {
    configurable: true,
    get() {
      return desc.get!.call(this);
    },
    set(fn: ((e: MessageEvent) => void) | null) {
      desc.set!.call(
        this,
        fn
          ? (e: MessageEvent) => {
              if (typeof e.data !== "string") w.__binaryReceived += (e.data as ArrayBuffer).byteLength;
              return fn(e);
            }
          : fn,
      );
    },
  });
  const arrayBuffer = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = async function (this: Blob) {
    if (w.__readDelay) await new Promise((r) => setTimeout(r, w.__readDelay));
    return arrayBuffer.call(this);
  };
};

const counter = (page: Page, name: "__binarySent" | "__binaryReceived") =>
  page.evaluate((key) => (window as unknown as Record<string, number>)[key], name);

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

async function downloadedBuffer(download: Download): Promise<Buffer> {
  const path = await download.path();
  return readFile(path!);
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

async function openDevice(browser: Browser, networkPref: "on" | "off" | null = "off", iphone = false): Promise<Page> {
  const context = await browser.newContext(
    iphone ? { userAgent: IPHONE_UA, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {},
  );
  await context.addInitScript(instrument);
  if (networkPref) {
    await context.addInitScript((pref) => localStorage.setItem("dropflow:network", pref), networkPref);
  }
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
  await expect(page.getByTestId("self-name")).toBeVisible();
  return page;
}

async function selfName(page: Page): Promise<string> {
  const text = await page.getByTestId("self-name").innerText();
  return text.replace(/^You appear as\s+/, "").split(" · ")[0].trim();
}

async function pair(a: Page, b: Page) {
  await a.getByTestId("open-pairing").click();
  await a.getByTestId("create-room").click();
  const code = (await a.getByTestId("room-code").innerText()).replace(/\s/g, "");
  expect(code).toMatch(/^\d{6}$/);
  await a.keyboard.press("Escape");

  await b.getByTestId("open-pairing").click();
  await b.getByTestId("code-input").fill(code);
  await b.getByTestId("code-submit").click();
  await expect(b.getByTestId("pairing-dialog")).toBeHidden();

  await expect(a.getByTestId("device-card")).toHaveCount(1);
  await expect(b.getByTestId("device-card")).toHaveCount(1);
}

test.describe("Step 2: discovery", () => {
  test("paired browsers discover each other, survive refresh, and disappear on close", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    const outsider = await openDevice(browser);

    await expect(a.getByTestId("empty-state")).toBeVisible();
    await pair(a, b);

    const bName = await selfName(b);
    await expect(a.getByTestId("device-card")).toHaveAttribute("data-peer-name", bName);
    await expect(outsider.getByTestId("device-card")).toHaveCount(0);

    await b.reload();
    await expect(b.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
    expect(await selfName(b)).toBe(bName);
    await expect(b.getByTestId("device-card")).toHaveCount(1);
    await expect(a.getByTestId("device-card")).toHaveCount(1);
    await a.waitForTimeout(500);
    await expect(a.getByTestId("device-card")).toHaveCount(1);

    await b.context().close();
    await expect(a.getByTestId("device-card")).toHaveCount(0, { timeout: 25_000 });

    await a.context().close();
    await outsider.context().close();
  });

  test("devices on the same network find each other automatically, and the switch hides them", async ({ browser }) => {
    const a = await openDevice(browser, null);
    const b = await openDevice(browser, null);
    await expect(a.getByTestId("device-card")).toHaveCount(1);
    await expect(b.getByTestId("device-card")).toHaveCount(1);
    await expect(a.getByTestId("device-card")).toHaveAttribute("data-peer-name", await selfName(b));

    await b.getByTestId("open-pairing").click();
    await expect(b.getByTestId("network-toggle")).toBeChecked();
    await b.getByTestId("network-toggle").click();
    await expect(b.getByTestId("network-toggle")).not.toBeChecked();
    await expect(a.getByTestId("device-card")).toHaveCount(0);

    await b.reload();
    await expect(b.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
    await b.waitForTimeout(500);
    await expect(a.getByTestId("device-card")).toHaveCount(0);
    await a.context().close();
    await b.context().close();
  });

  test("pairing QR code carries a joinable link", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await a.getByTestId("open-pairing").click();
    await a.getByTestId("create-room").click();
    const qr = a.getByTestId("pairing-qr");
    await expect(qr).toBeVisible();
    const link = await qr.getAttribute("data-value");
    expect(link).toMatch(/#join=[A-Za-z0-9_-]{43}$/);
    const fragment = link!.slice(link!.indexOf("#"));
    await b.goto("/" + fragment);
    await expect(b.getByTestId("device-card")).toHaveCount(1);
    await expect(a.getByTestId("device-card")).toHaveCount(1);
    expect(new URL(b.url()).hash).toBe("");
    await a.context().close();
    await b.context().close();
  });

  test("dev group is opt-in from the pairing dialog", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    for (const page of [a, b]) {
      await page.getByTestId("open-pairing").click();
      await page.getByTestId("dev-toggle").click();
      await expect(page.getByTestId("dev-toggle")).toBeChecked();
      await page.keyboard.press("Escape");
    }
    await expect(a.getByTestId("device-card")).toHaveCount(1);
    await expect(b.getByTestId("device-card")).toHaveCount(1);
    await a.context().close();
    await b.context().close();
  });
});

async function sendFiles(sender: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  await sender.getByTestId("file-input").first().setInputFiles(files);
}

test.describe("Step 3: WebRTC transfers", () => {
  test("a file goes Chrome to Chrome only after approval, and arrives byte-identical", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await pair(a, b);

    const original = randomBytes(20 * 1024 * 1024 + 12345);
    await sendFiles(a, [{ name: "sample.bin", mimeType: "application/octet-stream", buffer: original }]);

    const dialog = b.getByTestId("incoming-dialog");
    await expect(dialog).toBeVisible();
    await expect(b.getByTestId("incoming-sender")).toHaveText(await selfName(a));
    await expect(dialog).toContainText("sample.bin");
    await expect(dialog).toContainText("20 MB");
    await expect(a.getByTestId("transfer-row").first()).toHaveAttribute("data-status", "waiting");

    await b.waitForTimeout(1000);
    expect(await counter(a, "__binarySent")).toBe(0);
    expect(await counter(b, "__binaryReceived")).toBe(0);

    const percents: number[] = [];
    const sampler = setInterval(async () => {
      const text = await a.getByTestId("transfer-bytes").first().innerText().catch(() => "");
      const m = text.match(/^(\d+)%/);
      if (m) percents.push(Number(m[1]));
    }, 50);

    const downloadPromise = b.waitForEvent("download");
    await b.getByTestId("accept-transfer").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("sample.bin");
    const received = await downloadedBuffer(download);
    expect(received.length).toBe(original.length);
    expect(sha(received)).toBe(sha(original));

    const sentRow = a.getByTestId("transfer-row").first();
    await expect(sentRow).toHaveAttribute("data-status", "completed");
    await expect(sentRow.getByTestId("transfer-message")).toHaveText("Delivered and verified");
    clearInterval(sampler);

    expect(await counter(b, "__binaryReceived")).toBe(original.length);
    expect(await counter(a, "__binarySent")).toBe(original.length);
    for (let i = 1; i < percents.length; i++) expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
    expect(percents.some((p) => p > 0 && p < 100)).toBe(true);

    await expect(b.getByTestId("transfer-row").first()).toHaveAttribute("data-status", "completed");
    await a.context().close();
    await b.context().close();
  });
});

const slowSender = (page: Page, ms: number) =>
  page.evaluate((delay) => ((window as unknown as Record<string, number>).__readDelay = delay), ms);

async function untilProgress(page: Page) {
  await expect(page.getByTestId("transfer-row").first()).toHaveAttribute("data-status", "transferring");
  await expect
    .poll(async () => Number((await page.getByTestId("transfer-bytes").first().innerText()).match(/^(\d+)%/)?.[1] ?? 0))
    .toBeGreaterThan(0);
}

test.describe("Step 4: transfer experience", () => {
  test("declining sends no file bytes and tells the sender", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await pair(a, b);
    await sendFiles(a, [{ name: "secret.txt", mimeType: "text/plain", buffer: randomBytes(3 * 1024 * 1024) }]);
    await expect(b.getByTestId("incoming-dialog")).toBeVisible();
    await b.getByTestId("reject-transfer").click();

    const row = a.getByTestId("transfer-row").first();
    await expect(row).toHaveAttribute("data-status", "rejected");
    await expect(row.getByTestId("transfer-message")).toContainText("declined");
    expect(await counter(a, "__binarySent")).toBe(0);
    expect(await counter(b, "__binaryReceived")).toBe(0);
    await expect(b.getByTestId("transfer-row")).toHaveCount(0);
    await a.context().close();
    await b.context().close();
  });

  test("sender can cancel mid-transfer", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await pair(a, b);
    await slowSender(a, 150);
    await sendFiles(a, [{ name: "big.bin", mimeType: "application/octet-stream", buffer: randomBytes(30 * 1024 * 1024) }]);
    await b.getByTestId("accept-transfer").click();
    await untilProgress(a);

    await a.getByTestId("cancel-transfer").first().click();
    await expect(a.getByTestId("transfer-row").first()).toHaveAttribute("data-status", "cancelled");
    const bRow = b.getByTestId("transfer-row").first();
    await expect(bRow).toHaveAttribute("data-status", "cancelled");
    await expect(bRow.getByTestId("transfer-message")).toContainText("cancelled");
    await expect(b.getByTestId("received-item")).toHaveCount(0);
    expect(await counter(b, "__binaryReceived")).toBeLessThan(30 * 1024 * 1024);
    await a.context().close();
    await b.context().close();
  });

  test("receiver can cancel mid-transfer", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await pair(a, b);
    await slowSender(a, 150);
    await sendFiles(a, [{ name: "big.bin", mimeType: "application/octet-stream", buffer: randomBytes(30 * 1024 * 1024) }]);
    await b.getByTestId("accept-transfer").click();
    await untilProgress(b);

    await b.getByTestId("cancel-transfer").first().click();
    await expect(b.getByTestId("transfer-row").first()).toHaveAttribute("data-status", "cancelled");
    const aRow = a.getByTestId("transfer-row").first();
    await expect(aRow).toHaveAttribute("data-status", "cancelled");
    await expect(aRow.getByTestId("transfer-message")).toContainText("cancelled the transfer");
    await a.context().close();
    await b.context().close();
  });

  test("multiple files transfer sequentially and all verify", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await pair(a, b);
    const files = [
      { name: "one.jpg", mimeType: "image/jpeg", buffer: randomBytes(2 * 1024 * 1024 + 7) },
      { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
      { name: "three.pdf", mimeType: "application/pdf", buffer: randomBytes(5 * 1024 * 1024) },
    ];
    await sendFiles(a, files);
    await expect(b.getByTestId("incoming-files").locator("li")).toHaveCount(3);

    const downloads: Download[] = [];
    b.on("download", (d) => downloads.push(d));
    await b.getByTestId("accept-transfer").click();

    const row = a.getByTestId("transfer-row").first();
    await expect(row).toHaveAttribute("data-status", "completed");
    await expect(row.getByTestId("transfer-message")).toHaveText("3 files delivered and verified");
    await expect.poll(() => downloads.length).toBe(3);

    for (const file of files) {
      const d = downloads.find((x) => x.suggestedFilename() === file.name);
      expect(d, file.name).toBeTruthy();
      expect(sha(await downloadedBuffer(d!))).toBe(sha(file.buffer));
    }
    await expect(b.getByTestId("received-item")).toHaveCount(3);
    await a.context().close();
    await b.context().close();
  });

  test("a second batch waits in the queue until the first is done", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await pair(a, b);
    const first = randomBytes(1024 * 1024);
    const second = randomBytes(1024 * 1024 + 1);
    await sendFiles(a, [{ name: "first.bin", mimeType: "application/octet-stream", buffer: first }]);
    await sendFiles(a, [{ name: "second.bin", mimeType: "application/octet-stream", buffer: second }]);

    await expect(a.locator('[data-testid="transfer-row"][data-status="queued"]')).toHaveCount(1);
    await expect(b.getByTestId("incoming-dialog")).toContainText("first.bin");
    await b.getByTestId("accept-transfer").click();
    await expect(b.getByTestId("incoming-dialog")).toContainText("second.bin");
    await b.getByTestId("accept-transfer").click();

    await expect(a.locator('[data-testid="transfer-row"][data-status="completed"]')).toHaveCount(2);
    await expect(b.getByTestId("received-item")).toHaveCount(2);
    await a.context().close();
    await b.context().close();
  });

  test("receiver refreshing mid-transfer fails cleanly on the sender", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await pair(a, b);
    await slowSender(a, 150);
    await sendFiles(a, [{ name: "big.bin", mimeType: "application/octet-stream", buffer: randomBytes(30 * 1024 * 1024) }]);
    await b.getByTestId("accept-transfer").click();
    await untilProgress(a);

    b.on("dialog", (dialog) => void dialog.accept());
    await b.reload();
    const row = a.getByTestId("transfer-row").first();
    await expect(row).toHaveAttribute("data-status", /failed|cancelled/);
    await expect(row.getByTestId("transfer-message")).toContainText(/closed DropFlow|lost|offline/);

    await expect(b.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
    await expect(a.getByTestId("device-card")).toHaveCount(1);
    await expect(b.getByTestId("device-card")).toHaveCount(1);
    await a.context().close();
    await b.context().close();
  });

  test("receiver going offline mid-transfer fails cleanly on the sender", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await pair(a, b);
    await slowSender(a, 150);
    await sendFiles(a, [{ name: "big.bin", mimeType: "application/octet-stream", buffer: randomBytes(30 * 1024 * 1024) }]);
    await b.getByTestId("accept-transfer").click();
    await untilProgress(a);

    await b.context().close();
    const row = a.getByTestId("transfer-row").first();
    await expect(row).toHaveAttribute("data-status", "failed", { timeout: 30_000 });
    await expect(row.getByTestId("transfer-message")).toContainText(/closed DropFlow|lost|offline/);
    await a.context().close();
  });

  test("an iPhone gets a save sheet instead of an automatic download, and Save delivers the exact file", async ({ browser }) => {
    const a = await openDevice(browser);
    const phone = await openDevice(browser, "off", true);
    await pair(a, phone);
    const files = [
      { name: "photo.png", mimeType: "image/png", buffer: randomBytes(400_000) },
      { name: "notes.pdf", mimeType: "application/pdf", buffer: randomBytes(150_000) },
    ];
    await sendFiles(a, files);

    let autoDownloads = 0;
    phone.on("download", () => autoDownloads++);
    await phone.getByTestId("accept-transfer").click();
    const sheet = phone.getByTestId("received-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("received-sheet-item")).toHaveCount(2);
    await expect(sheet.locator("img")).toHaveCount(1);
    expect(autoDownloads).toBe(0);

    for (const [i, file] of files.entries()) {
      const download = phone.waitForEvent("download");
      await sheet.getByTestId("sheet-save").nth(i).click();
      const d = await download;
      expect(d.suggestedFilename()).toBe(file.name);
      expect(sha(await downloadedBuffer(d))).toBe(sha(file.buffer));
    }

    await phone.getByTestId("sheet-done").click();
    await expect(sheet).toBeHidden();
    await expect(phone.getByTestId("received-item")).toHaveCount(2);
    await a.context().close();
    await phone.context().close();
  });

  test("transfers report the connection route", async ({ browser }) => {
    const a = await openDevice(browser);
    const b = await openDevice(browser);
    await pair(a, b);
    await sendFiles(a, [{ name: "r.bin", mimeType: "application/octet-stream", buffer: randomBytes(2 * 1024 * 1024) }]);
    await b.getByTestId("accept-transfer").click();
    await expect(a.getByTestId("transfer-route").first()).toHaveAttribute("data-route", "local");
    await expect(a.getByTestId("transfer-route").first()).toHaveText("Direct · same network");
    await a.context().close();
    await b.context().close();
  });
});
