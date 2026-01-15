import { chromium, type Page } from "playwright";
import { existsSync } from "fs";
import { unlink, rename } from "fs/promises";
import { join } from "path";
import { SESSION_PATH, ensureDayDir, buildScreenshotPath } from "./utils";
import { isEventPromotion } from "./vision";

const STORY_DELAY_MS = 1500; // Watch each story for ~1.5 seconds
const TEMP_SCREENSHOT = join(import.meta.dir, "..", "temp_screenshot.png");

async function getUsername(page: Page): Promise<string> {
  try {
    // Try to get username from the story header - look for the username link in the active story
    const usernameLink = page.locator('section[role="presentation"] a[href^="/"]').first();
    const href = await usernameLink.getAttribute("href", { timeout: 2000 });
    if (href) {
      // href is like "/username/" - extract just the username
      const username = href.replace(/\//g, "");
      if (username && username.length > 0) {
        return username;
      }
    }
  } catch {
    // Try alternate selector - look for any visible username text
    try {
      const usernameSpan = page.locator('section[role="presentation"] header span').first();
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

async function hasMoreStories(page: Page): Promise<boolean> {
  // Check if there's a "next story" button or if we're at the end
  try {
    const nextButton = page.locator('button[aria-label="Next"]');
    return (await nextButton.count()) > 0;
  } catch {
    return false;
  }
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
    // Click far right to skip to next user's stories
    const viewportSize = page.viewportSize();
    if (viewportSize) {
      await page.mouse.click(viewportSize.width * 0.85, viewportSize.height * 0.5);
      await page.waitForTimeout(500);
      return true;
    }
  } catch (e) {
    console.log("Could not skip to next user:", e);
  }
  return false;
}


async function isStoryView(page: Page): Promise<boolean> {
  // Check if we're viewing a story (URL contains /stories/)
  return page.url().includes("/stories/");
}

export async function runScraper(): Promise<void> {
  if (!existsSync(SESSION_PATH)) {
    console.error("No session found. Please run 'bun run setup' first.");
    process.exit(1);
  }

  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY environment variable is not set.");
    console.error("Please create a .env file with your OpenRouter API key.");
    process.exit(1);
  }

  console.log("Starting Instagram story scraper...");

  const browser = await chromium.launch({ headless: false }); // Set to true for background operation
  const context = await browser.newContext({
    storageState: SESSION_PATH,
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  try {
    // Navigate to Instagram
    console.log("Navigating to Instagram...");
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // Click on the first story in the story tray
    console.log("Looking for stories...");
    const storyButton = page.locator('div[role="button"] canvas').first();

    if ((await storyButton.count()) === 0) {
      console.log("No stories found in your feed.");
      await browser.close();
      return;
    }

    await storyButton.click();
    await page.waitForTimeout(2000);

    // Ensure day directory exists
    const dayDir = await ensureDayDir();
    console.log(`Saving events to: ${dayDir}\n`);

    let storyCount = 0;
    let eventCount = 0;
    let lastUrl = "";
    let stuckCount = 0;
    const MAX_STUCK = 3; // Skip to next user after 3 failed advances

    // Process stories
    while (await isStoryView(page)) {
      const currentUrl = page.url();

      // Check if we're stuck on the same story/reel
      if (currentUrl === lastUrl) {
        stuckCount++;
        if (stuckCount >= MAX_STUCK) {
          console.log(`  -> Stuck on same content, skipping to next user...`);
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
      console.log(`Story ${storyCount}: @${username}`);

      // Take screenshot of just the center story (not adjacent stories)
      // Story is centered in viewport, roughly 405px wide
      const viewportSize = page.viewportSize();
      if (viewportSize) {
        const storyWidth = 405;
        const storyX = (viewportSize.width - storyWidth) / 2;
        await page.screenshot({
          path: TEMP_SCREENSHOT,
          clip: { x: storyX, y: 0, width: storyWidth, height: viewportSize.height }
        });
      } else {
        await page.screenshot({ path: TEMP_SCREENSHOT, clip: { x: 437, y: 0, width: 405, height: 720 } });
      }

      // Check if it's an event
      try {
        const isEvent = await isEventPromotion(TEMP_SCREENSHOT);

        if (isEvent) {
          const savePath = buildScreenshotPath(username, dayDir);
          await rename(TEMP_SCREENSHOT, savePath);
          eventCount++;
          console.log(`  -> EVENT DETECTED! Saved to ${savePath}`);
        } else {
          await unlink(TEMP_SCREENSHOT).catch(() => {});
          console.log(`  -> Not an event, discarded`);
        }
      } catch (err) {
        console.log(`  -> Error checking story: ${err}`);
        await unlink(TEMP_SCREENSHOT).catch(() => {});
      }

      // Wait a bit (simulate watching)
      await page.waitForTimeout(STORY_DELAY_MS);

      // Try to go to next story
      const advanced = await nextStory(page);
      if (!advanced) {
        console.log("\nReached end of stories or couldn't advance.");
        break;
      }

      // Small delay to let next story load
      await page.waitForTimeout(500);

      // Check if we're still in story view
      if (!(await isStoryView(page))) {
        console.log("\nExited story view.");
        break;
      }
    }

    console.log(`\nDone! Processed ${storyCount} stories, found ${eventCount} events.`);
  } catch (err) {
    console.error("Error during scraping:", err);
  } finally {
    // Cleanup temp file if exists
    await unlink(TEMP_SCREENSHOT).catch(() => {});
    await browser.close();
  }
}
