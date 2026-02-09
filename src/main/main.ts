import { app } from "electron";
import { mkdir } from "fs/promises";
import { createTray } from "./tray";
import { getAuthDir, getEventsDir } from "../core/utils";

// Hide dock icon on macOS — tray-only app
if (process.platform === "darwin") {
  app.dock?.hide();
}

app.whenReady().then(async () => {
  // Ensure data directories exist
  await mkdir(getAuthDir(), { recursive: true });
  await mkdir(getEventsDir(), { recursive: true });

  createTray();
});

// Keep app running when all windows are closed (tray app)
app.on("window-all-closed", () => {
  // Don't quit — tray app stays running
});
