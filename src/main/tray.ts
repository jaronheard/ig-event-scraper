import {
  Tray,
  Menu,
  nativeImage,
  NativeImage,
  Notification,
  shell,
  dialog,
  BrowserWindow,
  ipcMain,
} from "electron";
import { join } from "path";
import { existsSync } from "fs";
import store from "./store";
import { runScraper, type ScanResult } from "../core/scraper";
import { runSetup } from "../core/setup";
import { getEventsDir, getSessionPath } from "../core/utils";

let tray: Tray | null = null;
let isScanning = false;

function getTrayIcon(): string {
  if (process.platform === "darwin") {
    return join(__dirname, "..", "..", "assets", "iconTemplate.png");
  }
  return join(__dirname, "..", "..", "assets", "icon.png");
}

function buildMenu(): Menu {
  const lastScan = store.get("lastScanTime");
  const lastCount = store.get("lastEventCount");
  const hasSession = existsSync(getSessionPath());

  const scanLabel = isScanning ? "Scanning..." : "Scan Stories Now";
  const statusLabel = lastScan
    ? `Last scan: ${lastScan} | Events: ${lastCount}`
    : "No scans yet";

  return Menu.buildFromTemplate([
    {
      label: scanLabel,
      enabled: !isScanning && hasSession,
      click: handleScan,
    },
    { type: "separator" },
    {
      label: statusLabel,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "View Events Folder",
      click: () => {
        const eventsDir = getEventsDir();
        shell.openPath(eventsDir);
      },
    },
    { type: "separator" },
    {
      label: hasSession ? "Re-login to Instagram" : "Login to Instagram",
      click: handleLogin,
    },
    {
      label: "Settings...",
      click: handleSettings,
    },
    { type: "separator" },
    {
      label: "Quit",
      role: "quit",
    },
  ]);
}

function updateMenu(): void {
  if (tray) {
    tray.setContextMenu(buildMenu());
  }
}

async function handleScan(): Promise<void> {
  if (isScanning) return;

  const apiKey = store.get("openrouterApiKey");
  if (!apiKey) {
    dialog.showErrorBox(
      "API Key Required",
      "Please set your OpenRouter API key in Settings first."
    );
    return;
  }

  // Set API key in env for the AI SDK
  process.env.OPENROUTER_API_KEY = apiKey;

  isScanning = true;
  updateMenu();

  try {
    const result: ScanResult = await runScraper((msg) => {
      console.log(msg);
    });

    if (result.error) {
      new Notification({
        title: "Scan Failed",
        body: result.error,
      }).show();
    } else {
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      store.set("lastScanTime", timeStr);
      store.set("lastEventCount", result.eventCount);

      new Notification({
        title: "Scan Complete",
        body: `Found ${result.eventCount} events in ${result.storyCount} stories.`,
      }).show();
    }
  } catch (err) {
    new Notification({
      title: "Scan Error",
      body: `${err}`,
    }).show();
  } finally {
    isScanning = false;
    updateMenu();
  }
}

async function handleLogin(): Promise<void> {
  try {
    await runSetup();
    new Notification({
      title: "Login Successful",
      body: "Instagram session saved. You can now scan stories.",
    }).show();
    updateMenu();
  } catch (err) {
    dialog.showErrorBox("Login Error", `Failed to save session: ${err}`);
  }
}

function handleSettings(): void {
  const preloadPath = join(__dirname, "..", "preload", "preload.js");

  const settingsWindow = new BrowserWindow({
    width: 450,
    height: 300,
    resizable: false,
    title: "Settings",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });

  // Handle save-settings IPC from the renderer
  const handler = (_event: Electron.IpcMainInvokeEvent, settings: Record<string, unknown>) => {
    if (typeof settings.openrouterApiKey === "string") {
      store.set("openrouterApiKey", settings.openrouterApiKey);
    }
    settingsWindow.close();
  };
  ipcMain.handle("save-settings", handler);

  // Clean up handler when window closes
  settingsWindow.on("closed", () => {
    ipcMain.removeHandler("save-settings");
  });

  const currentKey = store.get("openrouterApiKey") || "";
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          padding: 24px;
          background: #1a1a1a;
          color: #e0e0e0;
          margin: 0;
        }
        h2 { margin-top: 0; font-size: 18px; color: #fff; }
        label { display: block; margin-bottom: 6px; font-size: 13px; color: #aaa; }
        input {
          width: 100%;
          padding: 8px 10px;
          border: 1px solid #444;
          border-radius: 6px;
          background: #2a2a2a;
          color: #e0e0e0;
          font-size: 14px;
          box-sizing: border-box;
          margin-bottom: 16px;
        }
        input:focus { outline: none; border-color: #6366f1; }
        button {
          background: #6366f1;
          color: white;
          border: none;
          padding: 8px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        }
        button:hover { background: #5558e6; }
        .hint { font-size: 11px; color: #666; margin-top: 4px; }
      </style>
    </head>
    <body>
      <h2>Settings</h2>
      <label for="apiKey">OpenRouter API Key</label>
      <input type="password" id="apiKey" value="${currentKey}" placeholder="sk-or-..." />
      <p class="hint">Get a key at openrouter.ai</p>
      <button onclick="save()">Save</button>
      <script>
        function save() {
          const key = document.getElementById('apiKey').value;
          window.electronAPI.saveSettings({ openrouterApiKey: key });
        }
      </script>
    </body>
    </html>
  `;

  settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  settingsWindow.setMenuBarVisibility(false);
}

export function createTray(): void {
  const iconPath = getTrayIcon();

  // Create a simple icon if asset doesn't exist yet
  let icon: NativeImage;
  if (existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    // Fallback: create a tiny 16x16 icon
    icon = nativeImage.createEmpty();
  }

  if (process.platform === "darwin") {
    icon = icon.resize({ width: 16, height: 16 });
  }

  tray = new Tray(icon);
  tray.setToolTip("Scene Scout");
  tray.setContextMenu(buildMenu());
}
