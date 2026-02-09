import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { dialog } from "electron";
import { getAuthDir, getSessionPath } from "./utils";
import { getPlaywrightBrowserPath } from "./playwright-config";

export async function runSetup(): Promise<void> {
  await mkdir(getAuthDir(), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    executablePath: getPlaywrightBrowserPath(),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  await page.goto("https://www.instagram.com/accounts/login/");

  // Show dialog instead of waiting for stdin
  await dialog.showMessageBox({
    type: "info",
    title: "Instagram Login",
    message: "Log into Instagram in the browser window that just opened.",
    detail: "Once you're logged in and can see your feed, click OK to save your session.",
    buttons: ["OK"],
  });

  // Save the session
  const sessionPath = getSessionPath();
  await context.storageState({ path: sessionPath });

  await browser.close();
}
