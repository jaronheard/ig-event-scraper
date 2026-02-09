import { mkdir, readdir } from "fs/promises";
import { join, basename } from "path";
import { app } from "electron";

function getDataDir(): string {
  return app.getPath("userData");
}

export function getAuthDir(): string {
  return join(getDataDir(), "auth");
}

export function getEventsDir(): string {
  return join(getDataDir(), "events");
}

export function getSessionPath(): string {
  return join(getAuthDir(), "session.json");
}

export function getTempScreenshotPath(): string {
  return join(getDataDir(), "temp_screenshot.png");
}

export function getDateString(): string {
  const now = new Date();
  return now.toISOString().split("T")[0]!;
}

export function getTimeString(): string {
  const now = new Date();
  return now.toTimeString().split(" ")[0]!.replace(/:/g, "-");
}

export async function ensureDayDir(): Promise<string> {
  const dayDir = join(getEventsDir(), getDateString());
  await mkdir(dayDir, { recursive: true });
  return dayDir;
}

export function buildScreenshotPath(username: string, dayDir: string): string {
  const time = getTimeString();
  const sanitizedUsername = username.replace(/[^a-zA-Z0-9_]/g, "_");
  return join(dayDir, `${sanitizedUsername}_${time}.png`);
}

export interface AccountImage {
  path: string;
  date: string;
}

export async function scanAccountImages(): Promise<Record<string, AccountImage[]>> {
  const eventsDir = getEventsDir();
  const result: Record<string, AccountImage[]> = {};

  let dateDirs: string[];
  try {
    dateDirs = await readdir(eventsDir);
  } catch {
    return result;
  }

  for (const dateDir of dateDirs) {
    // Only process YYYY-MM-DD directories
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateDir)) continue;

    const dirPath = join(eventsDir, dateDir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".png")) continue;
      // Filename format: username_HH-MM-SS.png
      const name = basename(file, ".png");
      const lastUnderscore = name.lastIndexOf("_");
      if (lastUnderscore === -1) continue;
      const username = name.substring(0, lastUnderscore);

      if (!result[username]) {
        result[username] = [];
      }
      result[username].push({
        path: join(dirPath, file),
        date: dateDir,
      });
    }
  }

  return result;
}
