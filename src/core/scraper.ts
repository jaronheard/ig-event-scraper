import { chromium, type Page } from "playwright";
import { existsSync } from "fs";
import { unlink, rename } from "fs/promises";
import {
  getSessionPath,
  ensureDayDir,
  buildScreenshotPath,
  getTempScreenshotPath,
} from "./utils";
import { isEventPromotion } from "./vision";
import { getPlaywrightBrowserPath } from "./playwright-config";

const STORY_DELAY_MS = 1500;
const MAX_STUCK = 3;

async function getUsername(page: Page): Promise<string> {
  try {
    const usernameLink = page
      .locator('section[role="presentation"] a[href^="/"]')
      .first();
    const href = await usernameLink.getAttribute("href", { timeout: 2000 });
    if (href) {
      const username = href.replace(/\//g, "");
      if (username && username.length > 0) {
        return username;
      }
    }
  } catch {
    try {
      const usernameSpan = page
        .locator('section[role="presentation"] header span')
        .first();
      const text = await usernameSpan.textContent({ timeout: 1000 });
      if (text && text.length > 0 && text.length < 50) {
        return text.trim();
      }
    } catch {
      // Fallback
    }
  }
  return "unknown_" + Date.now();
}

async function nextStory(page: Page): Promise<boolean> {
  try {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    return true;
  } catch (e) {
    console.log("Could not advance to next story:", e);
  }
  return false;
}

async function skipToNextUser(page: Page): Promise<boolean> {
  try {
    const viewportSize = page.viewportSize();
    if (viewportSize) {
      await page.mouse.click(
        viewportSize.width * 0.85,
        viewportSize.height * 0.5
      );
      await page.waitForTimeout(500);
      return true;
    }
  } catch (e) {
    console.log("Could not skip to next user:", e);
  }
  return false;
}

async function isStoryView(page: Page): Promise<boolean> {
  return page.url().includes("/stories/");
}

export interface ScanResult {
  storyCount: number;
  eventCount: number;
  error?: string;
}

export async function runScraper(
  onProgress?: (msg: string) => void
): Promise<ScanResult> {
  const sessionPath = getSessionPath();
  const tempScreenshot = getTempScreenshotPath();
  const log = onProgress || console.log;

  if (!existsSync(sessionPath)) {
    return {
      storyCount: 0,
      eventCount: 0,
      error: "No session found. Please log in to Instagram first.",
    };
  }

  log("Starting Instagram story scraper...");

  const browser = await chromium.launch({
    headless: true,
    executablePath: getPlaywrightBrowserPath(),
  });
  const context = await browser.newContext({
    storageState: sessionPath,
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  let storyCount = 0;
  let eventCount = 0;

  try {
    log("Navigating to Instagram...");
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2000);

    log("Looking for stories...");
    const storyButton = page.locator('div[role="button"] canvas').first();

    if ((await storyButton.count()) === 0) {
      log("No stories found in your feed.");
      await browser.close();
      return { storyCount: 0, eventCount: 0 };
    }

    await storyButton.click();
    await page.waitForTimeout(2000);

    const dayDir = await ensureDayDir();
    log(`Saving events to: ${dayDir}`);

    let lastUrl = "";
    let stuckCount = 0;

    while (await isStoryView(page)) {
      const currentUrl = page.url();

      if (currentUrl === lastUrl) {
        stuckCount++;
        if (stuckCount >= MAX_STUCK) {
          log("Stuck on same content, skipping to next user...");
          await skipToNextUser(page);
          stuckCount = 0;
          lastUrl = "";
          await page.waitForTimeout(500);
          continue;
        }
      } else {
        stuckCount = 0;
        lastUrl = currentUrl;
      }

      storyCount++;
      const username = await getUsername(page);
      log(`Story ${storyCount}: @${username}`);

      const viewportSize = page.viewportSize();
      if (viewportSize) {
        const storyWidth = 405;
        const storyX = (viewportSize.width - storyWidth) / 2;
        await page.screenshot({
          path: tempScreenshot,
          clip: {
            x: storyX,
            y: 0,
            width: storyWidth,
            height: viewportSize.height,
          },
        });
      } else {
        await page.screenshot({
          path: tempScreenshot,
          clip: { x: 437, y: 0, width: 405, height: 720 },
        });
      }

      try {
        const isEvent = await isEventPromotion(tempScreenshot);

        if (isEvent) {
          const savePath = buildScreenshotPath(username, dayDir);
          await rename(tempScreenshot, savePath);
          eventCount++;
          log(`  -> EVENT DETECTED! Saved`);
        } else {
          await unlink(tempScreenshot).catch(() => {});
          log(`  -> Not an event, discarded`);
        }
      } catch (err) {
        log(`  -> Error checking story: ${err}`);
        await unlink(tempScreenshot).catch(() => {});
      }

      await page.waitForTimeout(STORY_DELAY_MS);

      const advanced = await nextStory(page);
      if (!advanced) {
        log("Reached end of stories.");
        break;
      }

      await page.waitForTimeout(500);

      if (!(await isStoryView(page))) {
        log("Exited story view.");
        break;
      }
    }

    log(`Done! Processed ${storyCount} stories, found ${eventCount} events.`);
  } catch (err) {
    console.error("Error during scraping:", err);
    return {
      storyCount,
      eventCount,
      error: `Scraping error: ${err}`,
    };
  } finally {
    await unlink(tempScreenshot).catch(() => {});
    await browser.close();
  }

  return { storyCount, eventCount };
}
