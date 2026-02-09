import { join } from "path";
import { app } from "electron";
import { existsSync } from "fs";

export function getPlaywrightBrowserPath(): string | undefined {
  // In development, let Playwright use its default browser location
  if (!app.isPackaged) {
    return undefined;
  }

  // In production, use the bundled browser from extraResources
  const resourcesPath = process.resourcesPath;
  const browsersDir = join(resourcesPath, "playwright-browsers");

  // Find the chromium directory
  if (existsSync(browsersDir)) {
    const { readdirSync } = require("fs");
    const entries = readdirSync(browsersDir) as string[];
    const chromiumDir = entries.find((e: string) => e.startsWith("chromium-"));
    if (chromiumDir) {
      const platform = process.platform;
      if (platform === "darwin") {
        return join(browsersDir, chromiumDir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium");
      } else if (platform === "win32") {
        return join(browsersDir, chromiumDir, "chrome-win", "chrome.exe");
      } else {
        return join(browsersDir, chromiumDir, "chrome-linux", "chrome");
      }
    }
  }

  return undefined;
}
