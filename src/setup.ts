import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { AUTH_DIR, SESSION_PATH } from "./utils";

export async function runSetup(): Promise<void> {
  console.log("Starting Instagram login setup...");
  console.log("A browser window will open. Please log into Instagram manually.");
  console.log("Once logged in, press Enter in this terminal to save your session.\n");

  await mkdir(AUTH_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  await page.goto("https://www.instagram.com/accounts/login/");

  console.log("Waiting for you to log in...");
  console.log("Press Enter when you're logged in and see your feed.\n");

  // Wait for user to press Enter
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  // Save the session
  await context.storageState({ path: SESSION_PATH });
  console.log(`\nSession saved to ${SESSION_PATH}`);

  await browser.close();
  console.log("Setup complete! You can now run 'bun run scrape' to start scraping.");
}
