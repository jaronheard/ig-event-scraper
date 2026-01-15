import { mkdir } from "fs/promises";
import { join } from "path";

export const PROJECT_ROOT = join(import.meta.dir, "..");
export const AUTH_DIR = join(PROJECT_ROOT, "auth");
export const EVENTS_DIR = join(PROJECT_ROOT, "events");
export const SESSION_PATH = join(AUTH_DIR, "session.json");

export function getDateString(): string {
  const now = new Date();
  return now.toISOString().split("T")[0];
}

export function getTimeString(): string {
  const now = new Date();
  return now.toTimeString().split(" ")[0].replace(/:/g, "-");
}

export async function ensureDayDir(): Promise<string> {
  const dayDir = join(EVENTS_DIR, getDateString());
  await mkdir(dayDir, { recursive: true });
  return dayDir;
}

export function buildScreenshotPath(username: string, dayDir: string): string {
  const time = getTimeString();
  const sanitizedUsername = username.replace(/[^a-zA-Z0-9_]/g, "_");
  return join(dayDir, `${sanitizedUsername}_${time}.png`);
}
