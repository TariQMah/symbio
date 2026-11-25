// Remote access: one button copies the link and code together, and a share button
// hands the same text to the share sheet (or copies it where there is none).
import { after, before, test } from "node:test";
import { closeBrowser, openPage, startSymbio, until, type Symbio } from "./harness.js";

let symbio: Symbio;
before(async () => { symbio = await startSymbio(); });
after(async () => { await closeBrowser(); await symbio?.stop(); });

test("remote access: copy the link and code together, and share them", async () => {
  const { page, context } = await openPage(symbio);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // As if remote access were on: the link and code come from the server, and
  // standing up a real one here would need a tunnel out to the internet.
  await page.route("**/api/remote", (route) =>
    route.fulfill({
      json: {
        active: true,
        url: "https://try-abc123.symbio.link",
        code: "12345678",
        startedAt: Date.now(),
        sessions: 0,
      },
    }),
  );
  await page.goto(`${symbio.base}/#/settings`);

  const shareText = "Symbio: https://try-abc123.symbio.link\nAccess code: 1234-5678";
  await page.locator("a", { hasText: "https://try-abc123.symbio.link" }).waitFor();

  // The buttons show on hover; clicked directly here. waitForFunction doesn't wait for a promise, so the clipboard is polled.
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText().then((t) => t.replace(/\r\n/g, "\n")));

  // "Copy link and code" copies both together, in the format from the issue.
  const copyBoth = page.locator('button[title="Copy link and code"]');
  await copyBoth.evaluate((el) => (el as HTMLButtonElement).click());
  await until("the link and code to be copied together", async () => (await clipboard()) === shareText);
  await page.locator('button[title="Link and code copied"]').first().waitFor();

  // The code on its own still copies just the code.
  const copyCode = page.locator('button[title="Copy access code"]');
  await copyCode.evaluate((el) => (el as HTMLButtonElement).click());
  await until("the access code to be copied on its own", async () => (await clipboard()) === "1234-5678");
  await page.locator('button[title="Access code copied"]').waitFor();

  // The share button hands the same text to the share sheet...
  const share = page.locator('button[title="Share"]');
  await page.evaluate(() => {
    (window as any).__shared = null;
    Object.defineProperty(navigator, "share", {
      value: async (data: { text: string }) => {
        (window as any).__shared = data.text;
      },
      configurable: true,
    });
  });
  await share.evaluate((el) => (el as HTMLButtonElement).click());
  await until("the link and code to be shared", async () => (await page.evaluate(() => (window as any).__shared)) === shareText);

  // ...and where there is no share sheet it copies the same text instead.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
  });
  await share.evaluate((el) => (el as HTMLButtonElement).click());
  await until("the link and code to be copied from the share button", async () => (await clipboard()) === shareText);
  await page.locator('button[title="Link and code copied"]').first().waitFor();
});
