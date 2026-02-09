import { mkdir } from "fs/promises";
import { join } from "path";
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
