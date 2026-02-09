import { app, protocol, net } from "electron";
import { mkdir } from "fs/promises";
import { join, normalize } from "path";
import { pathToFileURL } from "url";
import { createTray, openOnboardingWindow, startAutoScan } from "./tray";
import store from "./store";
import { getAuthDir, getEventsDir } from "../core/utils";

// Register custom protocol scheme before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: "scene-scout", privileges: { bypassCSP: true, supportFetchAPI: true } },
]);

// Hide dock icon on macOS — tray-only app
if (process.platform === "darwin") {
  app.dock?.hide();
}

app.whenReady().then(async () => {
  // Ensure data directories exist
  await mkdir(getAuthDir(), { recursive: true });
  await mkdir(getEventsDir(), { recursive: true });

  // Handle scene-scout:// protocol for serving local event images
  // URLs look like: scene-scout://local/2026-02-09/file.png
  protocol.handle("scene-scout", (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname);
    const eventsDir = getEventsDir();
    const resolved = normalize(join(eventsDir, filePath));

    // Path traversal protection
    if (!resolved.startsWith(eventsDir)) {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(pathToFileURL(resolved).href);
  });

  createTray();

  if (!store.get("onboardingComplete")) {
    openOnboardingWindow();
  } else {
    startAutoScan();
  }
});

// Keep app running when all windows are closed (tray app)
app.on("window-all-closed", () => {
  // Don't quit — tray app stays running
});
