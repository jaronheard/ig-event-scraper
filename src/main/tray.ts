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
  powerMonitor,
} from "electron";
import { join, basename } from "path";
import { existsSync, copyFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import store, { type ReviewHistoryEntry } from "./store";
import { runScraper, type ScanResult } from "../core/scraper";
import { runSetup } from "../core/setup";
import { getEventsDir, getSessionPath, scanAccountImages } from "../core/utils";

let tray: Tray | null = null;
let isScanning = false;
let settingsWindow: BrowserWindow | null = null;
let reviewWindow: BrowserWindow | null = null;
let accountViewerWindow: BrowserWindow | null = null;
let onboardingWindow: BrowserWindow | null = null;
let autoScanTimer: ReturnType<typeof setInterval> | null = null;

const AUTO_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const AUTO_SCAN_MIN_GAP_MS = 3.5 * 60 * 60 * 1000; // 3.5 hours
const IDLE_THRESHOLD_SECONDS = 1800; // 30 minutes

interface ScanProgress {
  phase: "idle" | "scanning" | "analyzing" | "error" | "done";
  currentStory: number;
  totalStories: string; // "?" until done
  currentUser: string;
  eventCount: number;
  message: string;
}

let scanProgress: ScanProgress = {
  phase: "idle",
  currentStory: 0,
  totalStories: "?",
  currentUser: "",
  eventCount: 0,
  message: "",
};

function setTrayStatus(text: string): void {
  if (!tray) return;
  if (process.platform === "darwin") {
    tray.setTitle(text);
  } else {
    tray.setToolTip(text ? `Scene Scout - ${text}` : "Scene Scout");
  }
}

function parseProgressMessage(msg: string): void {
  // "Story 3: @username"
  const storyMatch = msg.match(/^Story (\d+): @(.+)$/);
  if (storyMatch) {
    scanProgress.phase = "scanning";
    scanProgress.currentStory = parseInt(storyMatch[1], 10);
    scanProgress.currentUser = storyMatch[2];
    scanProgress.message = msg;
    updateMenu();
    return;
  }

  // "  -> EVENT DETECTED! Saved"
  if (msg.includes("EVENT DETECTED")) {
    scanProgress.eventCount++;
    scanProgress.phase = "scanning";
    updateMenu();
    return;
  }

  // "  -> Not an event" or "  -> Error checking story"
  if (msg.startsWith("  ->")) {
    // Keep scanning phase, no special update needed
    return;
  }

  // "Navigating to Instagram..." / "Looking for stories..."
  if (msg.includes("Navigating") || msg.includes("Looking for")) {
    scanProgress.phase = "scanning";
    scanProgress.message = msg;
    return;
  }

  // "Done! Processed X stories, found Y events."
  const doneMatch = msg.match(/^Done! Processed (\d+) stories, found (\d+) events/);
  if (doneMatch) {
    scanProgress.phase = "done";
    scanProgress.currentStory = parseInt(doneMatch[1], 10);
    scanProgress.totalStories = doneMatch[1];
    scanProgress.eventCount = parseInt(doneMatch[2], 10);
    return;
  }

  // Generic progress
  scanProgress.message = msg;
}

function getTrayIcon(): string {
  if (process.platform === "darwin") {
    return join(__dirname, "..", "..", "assets", "iconTemplate.png");
  }
  return join(__dirname, "..", "..", "assets", "icon.png");
}

function buildMenu(): Menu {
  const lastScan = store.get("lastScanTime");
  const lastCount = store.get("lastEventCount");
  const lastStoryCount = store.get("lastStoryCount");
  const lastError = store.get("lastError");
  const hasSession = existsSync(getSessionPath());

  const scanLabel = isScanning ? "Scanning..." : "Scan Stories Now";

  const statusItems: Electron.MenuItemConstructorOptions[] = [];

  if (isScanning) {
    // Live progress during scan
    if (scanProgress.currentUser) {
      statusItems.push({
        label: `Scanning @${scanProgress.currentUser}...`,
        enabled: false,
      });
    }
    statusItems.push({
      label: `Stories: ${scanProgress.currentStory} | Events: ${scanProgress.eventCount}`,
      enabled: false,
    });
  } else if (lastError) {
    // Last scan failed
    statusItems.push({
      label: `Last scan failed: ${lastError}`,
      enabled: false,
    });
  } else if (lastScan) {
    // Successful last scan
    statusItems.push({
      label: `Last scan: ${lastScan}`,
      enabled: false,
    });
    statusItems.push({
      label: `Stories scanned: ${lastStoryCount}`,
      enabled: false,
    });
    statusItems.push({
      label: `Events found: ${lastCount}`,
      enabled: false,
    });
  } else {
    statusItems.push({
      label: "No scans yet",
      enabled: false,
    });
  }

  const autoScanEnabled = store.get("autoScanEnabled");

  const autoScanItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Auto-Scan Every 4 Hours",
      type: "checkbox",
      checked: autoScanEnabled,
      click: () => {
        const newVal = !store.get("autoScanEnabled");
        store.set("autoScanEnabled", newVal);
        if (newVal) {
          startAutoScan();
        } else {
          stopAutoScan();
        }
        updateMenu();
      },
    },
  ];

  if (autoScanEnabled) {
    autoScanItems.push({
      label: getNextAutoScanLabel(),
      enabled: false,
    });
  }

  return Menu.buildFromTemplate([
    {
      label: scanLabel,
      enabled: !isScanning && hasSession,
      click: handleScan,
    },
    { type: "separator" },
    ...statusItems,
    { type: "separator" },
    ...autoScanItems,
    { type: "separator" },
    {
      label: "View Accounts",
      click: handleAccountViewer,
    },
    {
      label: "Review Events",
      click: openReviewWindow,
    },
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

function saveReviewHistory(): void {
  const reviewedKeys: string[] = store.get("reviewedEvents") || [];
  const rejectedKeys: string[] = store.get("rejectedEvents") || [];

  if (reviewedKeys.length === 0 && rejectedKeys.length === 0) return;

  // Extract unique account names from keys (format: "2026-02-08/username_14-30-00.png")
  const accounts = new Set<string>();
  for (const key of [...reviewedKeys, ...rejectedKeys]) {
    const filename = key.split("/").pop() || "";
    const match = filename.match(/^(.+?)_\d/);
    if (match) accounts.add(match[1]);
  }

  const entry: ReviewHistoryEntry = {
    timestamp: new Date().toISOString(),
    accounts: Array.from(accounts),
    approvedCount: reviewedKeys.length,
    rejectedCount: rejectedKeys.length,
  };

  const history: ReviewHistoryEntry[] = store.get("reviewHistory") || [];
  history.push(entry);
  store.set("reviewHistory", history);
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

  // Snapshot known event keys before scanning
  const reviewedBefore = new Set(store.get("reviewedEvents") || []);
  const rejectedBefore = new Set(store.get("rejectedEvents") || []);
  const accountsBefore = await scanAccountImages();
  const knownKeysBefore = new Set<string>();
  const eventsDir = getEventsDir();
  for (const images of Object.values(accountsBefore)) {
    for (const img of images) {
      knownKeysBefore.add(img.path.substring(eventsDir.length + 1));
    }
  }

  // Reset progress state
  scanProgress = {
    phase: "scanning",
    currentStory: 0,
    totalStories: "?",
    currentUser: "",
    eventCount: 0,
    message: "",
  };

  isScanning = true;
  store.set("lastError", "");
  setTrayStatus("●");
  updateMenu();

  try {
    const hiddenAccounts = store.get("hiddenAccounts") || [];
    const result: ScanResult = await runScraper((msg) => {
      console.log(msg);
      parseProgressMessage(msg);
    }, hiddenAccounts);

    if (result.error) {
      store.set("lastError", result.error);
      const notif = new Notification({
        title: "Scan Failed",
        body: result.error,
      });
      notif.show();
    } else {
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      store.set("lastScanTime", timeStr);
      store.set("lastEventCount", result.eventCount);
      store.set("lastStoryCount", result.storyCount);
      store.set("lastError", "");
      store.set("lastAutoScanTime", Date.now());

      // Count genuinely new events (not previously known or reviewed/rejected)
      const accountsAfter = await scanAccountImages();
      let newEventCount = 0;
      for (const images of Object.values(accountsAfter)) {
        for (const img of images) {
          const key = img.path.substring(eventsDir.length + 1);
          if (!knownKeysBefore.has(key) && !reviewedBefore.has(key) && !rejectedBefore.has(key)) {
            newEventCount++;
          }
        }
      }

      if (newEventCount > 0) {
        // Save current review session to history and reset for the new batch
        saveReviewHistory();
        store.set("reviewedEvents", []);
        store.set("rejectedEvents", []);

        // Reload review window if open
        if (reviewWindow && !reviewWindow.isDestroyed()) {
          reviewWindow.webContents.executeJavaScript("load()");
        }

        const notif = new Notification({
          title: "New Events Found",
          body: `${newEventCount} new event${newEventCount !== 1 ? "s" : ""} discovered.`,
        });
        notif.on("click", () => { openReviewWindow(); });
        notif.show();
      } else if (result.eventCount > 0) {
        const notif = new Notification({
          title: "Scan Complete",
          body: `No new events (${result.eventCount} total in ${result.storyCount} stories).`,
        });
        notif.on("click", () => { openReviewWindow(); });
        notif.show();
      } else {
        const notif = new Notification({
          title: "Scan Complete",
          body: `No events found in ${result.storyCount} stories.`,
        });
        notif.show();
      }
    }
  } catch (err) {
    const errorMsg = `${err}`;
    store.set("lastError", errorMsg);
    new Notification({
      title: "Scan Error",
      body: errorMsg,
    }).show();
  } finally {
    isScanning = false;
    scanProgress.phase = "idle";
    setTrayStatus("");
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

async function handleCopyAndOpenSoonlist(): Promise<void> {
  const reviewedKeys: string[] = store.get("reviewedEvents") || [];
  const eventsDir = getEventsDir();
  const username = store.get("soonlistUsername");

  // Collect existing reviewed event file paths
  const filePaths: string[] = [];
  for (const key of reviewedKeys) {
    const srcPath = join(eventsDir, key);
    if (existsSync(srcPath)) {
      filePaths.push(srcPath);
    }
  }

  if (filePaths.length === 0) {
    dialog.showErrorBox("No Events", "No reviewed event images found to copy.");
    return;
  }

  // Chunk into groups of 20
  const BATCH_SIZE = 20;
  const batches: string[][] = [];
  for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
    batches.push(filePaths.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    // Copy batch to clipboard using AppleScript (macOS)
    if (process.platform === "darwin") {
      const posixFiles = batches[i].map((p) => `(POSIX file "${p}")`).join(", ");
      const script = `set the clipboard to {${posixFiles}}`;
      try {
        execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
      } catch (err) {
        dialog.showErrorBox("Clipboard Error", `Failed to copy files: ${err}`);
        return;
      }
    }

    if (i === 0) {
      // First batch: open Soonlist
      shell.openExternal(`https://www.soonlist.com/${username}/upcoming`);
    }

    // Show dialog for all batches except the last one
    if (i < batches.length - 1) {
      await dialog.showMessageBox({
        type: "info",
        title: "Batch Copy",
        message: `Batch ${i + 1} of ${batches.length} copied (${batches[i].length} images).`,
        detail: "Paste into Soonlist, then click OK for the next batch.",
        buttons: ["OK"],
      });
    }
  }
}

function handleSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  const preloadPath = join(__dirname, "..", "preload", "preload.js");

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 440,
    resizable: false,
    title: "Settings",
    backgroundColor: "#f7f7f7",
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
    if (typeof settings.soonlistUsername === "string") {
      store.set("soonlistUsername", settings.soonlistUsername.trim());
    }
    settingsWindow?.close();
    updateMenu();
  };
  ipcMain.handle("save-settings", handler);

  // Clean up handler when window closes
  settingsWindow.on("closed", () => {
    ipcMain.removeHandler("save-settings");
    settingsWindow = null;
  });

  const currentKey = store.get("openrouterApiKey") || "";
  const currentUsername = store.get("soonlistUsername") || "";
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Kalam:wght@400;700&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'IBM Plex Sans', -apple-system, sans-serif;
          background: #f7f7f7;
          color: #162135;
          padding: 40px 36px 36px;
        }
        h2 {
          font-family: 'Kalam', cursive;
          font-weight: 700;
          font-size: 26px;
          color: #162135;
          letter-spacing: -0.3px;
          margin-bottom: 32px;
        }
        label {
          display: block;
          font-size: 11px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: #627296;
          margin-bottom: 10px;
        }
        input {
          width: 100%;
          padding: 12px 14px;
          border: 1px solid #dce0e8;
          border-radius: 8px;
          background: #ffffff;
          color: #162135;
          font-family: 'IBM Plex Sans', monospace;
          font-size: 14px;
          transition: border-color 0.25s, box-shadow 0.25s;
        }
        input:focus {
          outline: none;
          border-color: #5a32fb;
          box-shadow: 0 0 0 3px rgba(90, 50, 251, 0.15);
        }
        input::placeholder { color: #9ba3b5; }
        .hint {
          font-size: 12px;
          color: #627296;
          margin-top: 10px;
          margin-bottom: 32px;
        }
        button {
          background: #5a32fb;
          color: #ffffff;
          border: none;
          padding: 11px 32px;
          border-radius: 8px;
          cursor: pointer;
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.3px;
          transition: opacity 0.2s, transform 0.1s;
        }
        button:hover { opacity: 0.9; }
        button:active { transform: scale(0.97); }
      </style>
    </head>
    <body>
      <h2>Settings</h2>
      <label for="apiKey">OpenRouter API Key</label>
      <input type="password" id="apiKey" value="${currentKey}" placeholder="sk-or-..." />
      <p class="hint">Get a key at openrouter.ai</p>
      <label for="soonlistUser">Soonlist Username</label>
      <input type="text" id="soonlistUser" value="${currentUsername}" placeholder="your-username" />
      <p class="hint">Your username on soonlist.com</p>
      <button onclick="save()">Save</button>
      <script>
        function save() {
          const key = document.getElementById('apiKey').value;
          const username = document.getElementById('soonlistUser').value;
          window.electronAPI.saveSettings({ openrouterApiKey: key, soonlistUsername: username });
        }
      </script>
    </body>
    </html>
  `;

  settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  settingsWindow.setMenuBarVisibility(false);
}

function openReviewWindow(): void {
  if (reviewWindow && !reviewWindow.isDestroyed()) {
    reviewWindow.focus();
    return;
  }

  const preloadPath = join(__dirname, "..", "preload", "preload.js");

  reviewWindow = new BrowserWindow({
    width: 450,
    height: 740,
    resizable: false,
    title: "Review Events",
    backgroundColor: "#f7f7f7",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });

  const getUnreviewedHandler = async () => {
    const accounts = await scanAccountImages();
    const reviewedEvents: string[] = store.get("reviewedEvents") || [];
    const rejectedEvents: string[] = store.get("rejectedEvents") || [];
    const hiddenAccounts: string[] = store.get("hiddenAccounts") || [];
    const eventsDir = getEventsDir();

    const events: { key: string; url: string; username: string; date: string }[] = [];

    for (const [username, images] of Object.entries(accounts)) {
      if (hiddenAccounts.includes(username)) continue;
      for (const img of images) {
        const key = img.path.substring(eventsDir.length + 1); // e.g. "2026-02-08/user_14-30-00.png"
        if (reviewedEvents.includes(key) || rejectedEvents.includes(key)) continue;
        const relative = img.path.substring(eventsDir.length);
        events.push({
          key,
          url: `scene-scout://local${relative}`,
          username,
          date: img.date,
        });
      }
    }

    // Sort newest first
    events.sort((a, b) => b.date.localeCompare(a.date) || b.key.localeCompare(a.key));
    return events;
  };

  const reviewEventHandler = (_event: Electron.IpcMainInvokeEvent, key: string, approved: boolean) => {
    if (approved) {
      const reviewed: string[] = store.get("reviewedEvents") || [];
      if (!reviewed.includes(key)) {
        store.set("reviewedEvents", [...reviewed, key]);
      }
    } else {
      const rejected: string[] = store.get("rejectedEvents") || [];
      if (!rejected.includes(key)) {
        store.set("rejectedEvents", [...rejected, key]);
      }
    }
  };

  const exportEventsHandler = async () => {
    const result = await dialog.showOpenDialog({
      title: "Export Events",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Export Here",
    });
    if (result.canceled || result.filePaths.length === 0) return { success: false };

    const destDir = result.filePaths[0];
    const reviewedKeys: string[] = store.get("reviewedEvents") || [];
    const eventsDir = getEventsDir();
    let copied = 0;

    for (const key of reviewedKeys) {
      const srcPath = join(eventsDir, key);
      if (!existsSync(srcPath)) continue;
      const destPath = join(destDir, basename(key));
      copyFileSync(srcPath, destPath);
      copied++;
    }

    shell.openPath(destDir);
    return { success: true, count: copied };
  };

  const hideAccountHandler = (_event: Electron.IpcMainInvokeEvent, username: string) => {
    // Add to hiddenAccounts
    const hiddenAccounts: string[] = store.get("hiddenAccounts") || [];
    if (!hiddenAccounts.includes(username)) {
      store.set("hiddenAccounts", [...hiddenAccounts, username]);
    }
    // Bulk-reject all unreviewed events from this user
    const reviewedEvents: string[] = store.get("reviewedEvents") || [];
    const rejectedEvents: string[] = store.get("rejectedEvents") || [];
    const eventsDir = getEventsDir();
    let rejectedCount = 0;

    // Re-scan to find all events from this user
    // We use synchronous approach: scanAccountImages is async, but we already have event keys
    // Instead, reject from the known events list pattern
    return scanAccountImages().then((accounts) => {
      const images = accounts[username] || [];
      for (const img of images) {
        const key = img.path.substring(eventsDir.length + 1);
        if (!reviewedEvents.includes(key) && !rejectedEvents.includes(key)) {
          rejectedEvents.push(key);
          rejectedCount++;
        }
      }
      store.set("rejectedEvents", rejectedEvents);
      return { rejectedCount };
    });
  };

  const unhideAccountHandler = (_event: Electron.IpcMainInvokeEvent, username: string) => {
    const hiddenAccounts: string[] = store.get("hiddenAccounts") || [];
    store.set("hiddenAccounts", hiddenAccounts.filter((a) => a !== username));
    // Also un-reject events from this user that were bulk-rejected
    const rejectedEvents: string[] = store.get("rejectedEvents") || [];
    const eventsDir = getEventsDir();
    return scanAccountImages().then((accounts) => {
      const images = accounts[username] || [];
      const userKeys = new Set(images.map((img) => img.path.substring(eventsDir.length + 1)));
      store.set("rejectedEvents", rejectedEvents.filter((k) => !userKeys.has(k)));
    });
  };

  ipcMain.handle("get-unreviewed-events", getUnreviewedHandler);
  ipcMain.handle("review-event", reviewEventHandler);
  ipcMain.handle("hide-account", hideAccountHandler);
  ipcMain.handle("unhide-account", unhideAccountHandler);
  const copyAndOpenSoonlistHandler = () => {
    handleCopyAndOpenSoonlist();
  };

  const getReviewHistoryHandler = () => {
    return store.get("reviewHistory") || [];
  };

  ipcMain.handle("export-events", exportEventsHandler);
  ipcMain.handle("copy-and-open-soonlist", copyAndOpenSoonlistHandler);
  ipcMain.handle("get-review-history", getReviewHistoryHandler);

  reviewWindow.on("closed", () => {
    ipcMain.removeHandler("get-unreviewed-events");
    ipcMain.removeHandler("review-event");
    ipcMain.removeHandler("hide-account");
    ipcMain.removeHandler("unhide-account");
    ipcMain.removeHandler("export-events");
    ipcMain.removeHandler("copy-and-open-soonlist");
    ipcMain.removeHandler("get-review-history");
    reviewWindow = null;
  });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Kalam:wght@400;700&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'IBM Plex Sans', -apple-system, sans-serif;
          background: #f7f7f7;
          color: #162135;
          overflow-y: auto;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          user-select: none;
        }
        .progress-bar {
          width: 320px;
          height: 3px;
          background: #dce0e8;
          border-radius: 2px;
          margin-bottom: 16px;
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          background: #5a32fb;
          border-radius: 2px;
          transition: width 0.4s ease;
        }
        .progress-text {
          font-size: 12px;
          color: #627296;
          margin-bottom: 12px;
          letter-spacing: 0.5px;
        }
        .card-container {
          position: relative;
          width: 320px;
          height: 520px;
        }
        .card-container::before {
          content: '';
          position: absolute;
          top: 8px;
          left: 8px;
          right: -8px;
          bottom: -4px;
          background: #dce0e8;
          border-radius: 14px;
          opacity: 0.6;
        }
        .card {
          position: absolute;
          top: 0; left: 0;
          width: 100%;
          height: 100%;
          border-radius: 14px;
          overflow: hidden;
          background: #ffffff;
          border: 1px solid #dce0e8;
          box-shadow: 0 4px 20px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04);
          transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease;
          z-index: 1;
        }
        .card img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .card-info {
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          padding: 48px 20px 20px;
          background: linear-gradient(transparent, rgba(10, 10, 9, 0.7), rgba(10, 10, 9, 0.95));
          color: #f5f0e6;
        }
        .card-info .username {
          font-family: 'Kalam', cursive;
          font-weight: 700;
          font-size: 20px;
          letter-spacing: -0.3px;
        }
        .card-info .date {
          font-size: 12px;
          color: #c8cad0;
          margin-top: 4px;
          letter-spacing: 0.3px;
        }
        .card.slide-left {
          transform: translateX(-130%) rotate(-12deg);
          opacity: 0;
        }
        .card.slide-right {
          transform: translateX(130%) rotate(12deg);
          opacity: 0;
        }
        .controls {
          display: flex;
          gap: 16px;
          margin-top: 24px;
          z-index: 2;
        }
        .controls button {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 28px;
          border-radius: 40px;
          border: 1px solid #dce0e8;
          background: #ffffff;
          color: #344360;
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .controls button .icon { font-size: 16px; line-height: 1; }
        .btn-reject:hover {
          border-color: #f5c6c6;
          background: #fde8e8;
          color: #b91c1c;
        }
        .btn-approve {
          background: #5a32fb !important;
          color: #ffffff !important;
          border-color: transparent !important;
          font-weight: 600 !important;
        }
        .btn-approve:hover {
          opacity: 0.9;
          transform: scale(1.03);
        }
        .hint {
          margin-top: 16px;
          font-size: 11px;
          color: #9ba3b5;
          letter-spacing: 0.5px;
        }
        .empty-state {
          text-align: center;
          color: #627296;
        }
        .empty-state .icon {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: #ffffff;
          border: 1px solid #dce0e8;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 16px;
          font-size: 24px;
          color: #627296;
        }
        .empty-state .title {
          font-family: 'Kalam', cursive;
          font-size: 22px;
          color: #162135;
          margin-bottom: 8px;
          font-weight: 700;
        }
        .empty-state .sub {
          font-size: 13px;
          color: #627296;
        }
        .btn-export {
          margin-top: 20px;
          background: #5a32fb;
          color: #ffffff;
          border: none;
          padding: 11px 28px;
          border-radius: 8px;
          cursor: pointer;
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.3px;
          transition: opacity 0.2s, transform 0.1s;
        }
        .btn-export:hover { opacity: 0.9; }
        .btn-export:active { transform: scale(0.97); }
        .btn-block {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 28px;
          border-radius: 40px;
          border: 1px solid #dce0e8;
          background: #ffffff;
          color: #344360;
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .btn-block:hover {
          border-color: #f5c6c6;
          background: #fde8e8;
          color: #b91c1c;
        }
        .toast {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: #162135;
          color: #ffffff;
          padding: 10px 20px;
          border-radius: 8px;
          font-size: 13px;
          font-family: 'IBM Plex Sans', sans-serif;
          display: flex;
          align-items: center;
          gap: 12px;
          z-index: 100;
          box-shadow: 0 4px 20px rgba(0,0,0,0.15);
          animation: toast-in 0.25s ease;
        }
        .toast.fade-out {
          animation: toast-out 0.25s ease forwards;
        }
        .toast a {
          color: #a78bfa;
          text-decoration: none;
          font-weight: 600;
          cursor: pointer;
        }
        .toast a:hover { text-decoration: underline; }
        @keyframes toast-in {
          from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
          to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes toast-out {
          from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          to { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
        }
        .history-section {
          width: 320px;
          margin-top: 24px;
          text-align: left;
        }
        .history-section summary {
          font-size: 12px;
          font-weight: 600;
          color: #627296;
          cursor: pointer;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          padding: 4px 0;
        }
        .history-section summary:hover { color: #344360; }
        .history-entry {
          font-size: 12px;
          color: #627296;
          padding: 6px 0;
          border-bottom: 1px solid #eef0f4;
          line-height: 1.5;
        }
        .history-entry .history-date {
          color: #344360;
          font-weight: 500;
        }
        .history-entry .history-accounts {
          color: #5a32fb;
        }
      </style>
    </head>
    <body>
      <div id="app"></div>
      <script>
        let events = [];
        let currentIndex = 0;
        let animating = false;
        let reviewHistory = [];

        async function load() {
          events = await window.electronAPI.getUnreviewedEvents();
          reviewHistory = await window.electronAPI.getReviewHistory();
          currentIndex = 0;
          render();
        }

        function formatHistoryDate(iso) {
          const d = new Date(iso);
          return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
            ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }

        function renderHistory() {
          if (!reviewHistory || reviewHistory.length === 0) return '';
          let html = '<div class="history-section"><details><summary>Past sessions</summary>';
          const sorted = reviewHistory.slice().reverse();
          for (const entry of sorted) {
            const accounts = entry.accounts.map(function(a) { return '@' + esc(a); }).join(', ');
            html += '<div class="history-entry">' +
              '<span class="history-date">' + esc(formatHistoryDate(entry.timestamp)) + '</span> - ' +
              '<span class="history-accounts">' + accounts + '</span> - ' +
              entry.approvedCount + ' approved, ' + entry.rejectedCount + ' rejected' +
              '</div>';
          }
          html += '</details></div>';
          return html;
        }

        function render() {
          const app = document.getElementById('app');
          if (events.length === 0) {
            app.innerHTML = '<div class="empty-state">' +
              '<div class="icon">&#10003;</div>' +
              '<div class="title">All caught up</div>' +
              '<div class="sub">No events to review right now.</div></div>' +
              renderHistory();
            return;
          }

          if (currentIndex >= events.length) {
            app.innerHTML = '<div class="empty-state">' +
              '<div class="icon">&#10003;</div>' +
              '<div class="title">All done</div>' +
              '<div class="sub">Reviewed ' + events.length + ' event' + (events.length !== 1 ? 's' : '') + '.</div>' +
              '<button class="btn-export" onclick="openSoonlist()">Open Soonlist</button></div>' +
              renderHistory();
            return;
          }

          const ev = events[currentIndex];
          const pct = ((currentIndex) / events.length * 100).toFixed(1);
          app.innerHTML =
            '<div class="progress-text">' + (currentIndex + 1) + ' of ' + events.length + '</div>' +
            '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="card-container">' +
              '<div class="card" id="card">' +
                '<img src="' + esc(ev.url) + '" />' +
                '<div class="card-info">' +
                  '<div class="username">@' + esc(ev.username) + '</div>' +
                  '<div class="date">' + esc(ev.date) + '</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="controls">' +
              '<button class="btn-block" onclick="hideUser()"><span class="icon">&#128683;</span> Ban</button>' +
              '<button class="btn-reject" onclick="reject()"><span class="icon">&#10005;</span> No</button>' +
              '<button class="btn-approve" onclick="approve()"><span class="icon">&#10003;</span> Yes</button>' +
            '</div>' +
            '<div class="hint">X ban &middot; &#8592; / N no &middot; &#8594; / Y yes</div>';
        }

        function esc(s) {
          const d = document.createElement('div');
          d.textContent = s;
          return d.innerHTML;
        }

        async function review(approved) {
          if (animating || currentIndex >= events.length) return;
          animating = true;

          const card = document.getElementById('card');
          if (card) {
            card.classList.add(approved ? 'slide-right' : 'slide-left');
          }

          const ev = events[currentIndex];
          await window.electronAPI.reviewEvent(ev.key, approved);

          setTimeout(() => {
            currentIndex++;
            animating = false;
            render();
          }, 400);
        }

        function approve() { review(true); }
        function reject() { review(false); }

        async function exportEvents() {
          await window.electronAPI.exportEvents();
        }

        async function openSoonlist() {
          await window.electronAPI.copyAndOpenSoonlist();
        }

        let toastTimer = null;
        let hiddenEventsBackup = [];

        async function hideUser() {
          if (animating || currentIndex >= events.length) return;
          animating = true;

          const ev = events[currentIndex];
          const username = ev.username;

          const card = document.getElementById('card');
          if (card) card.classList.add('slide-left');

          // Call backend to hide account + bulk-reject
          await window.electronAPI.hideAccount(username);

          // Remove all events from this user in the local batch
          const removedEvents = events.filter(e => e.username === username);
          hiddenEventsBackup = removedEvents;
          events = events.filter(e => e.username !== username);

          showToast(username, removedEvents.length);

          setTimeout(() => {
            // currentIndex may now point beyond filtered list, clamp it
            if (currentIndex >= events.length) currentIndex = events.length;
            animating = false;
            render();
          }, 400);
        }

        function showToast(username, count) {
          // Remove existing toast
          const existing = document.querySelector('.toast');
          if (existing) existing.remove();
          if (toastTimer) clearTimeout(toastTimer);

          const toast = document.createElement('div');
          toast.className = 'toast';
          const safeUser = esc(username);
          const jsUser = username.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
          toast.innerHTML = '@' + safeUser + ' hidden (' + count + ' event' + (count !== 1 ? 's' : '') + ') <a onclick="undoHide(\\'' + jsUser + '\\')">Undo</a>';
          document.body.appendChild(toast);

          toastTimer = setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 250);
            hiddenEventsBackup = [];
          }, 3000);
        }

        async function undoHide(username) {
          // Remove toast
          const toast = document.querySelector('.toast');
          if (toast) toast.remove();
          if (toastTimer) clearTimeout(toastTimer);

          // Unhide the account and un-reject its events
          await window.electronAPI.unhideAccount(username);

          // Re-add events back into the batch
          if (hiddenEventsBackup.length > 0) {
            events.splice(currentIndex, 0, ...hiddenEventsBackup);
            hiddenEventsBackup = [];
          }
          render();
        }

        document.addEventListener('keydown', (e) => {
          if (e.key === 'y' || e.key === 'ArrowRight') approve();
          if (e.key === 'n' || e.key === 'ArrowLeft') reject();
          if (e.key === 'x' || e.key === 'X') hideUser();
        });

        load();
      </script>
    </body>
    </html>
  `;

  reviewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  reviewWindow.setMenuBarVisibility(false);
}

function handleAccountViewer(): void {
  if (accountViewerWindow && !accountViewerWindow.isDestroyed()) {
    accountViewerWindow.focus();
    return;
  }

  const preloadPath = join(__dirname, "..", "preload", "preload.js");

  const viewerWindow = new BrowserWindow({
    width: 400,
    height: 500,
    resizable: false,
    title: "Accounts",
    backgroundColor: "#f7f7f7",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });

  const getAccountsHandler = async () => {
    const accounts = await scanAccountImages();
    const hiddenAccounts = store.get("hiddenAccounts") || [];

    const result: Record<string, { eventCount: number; hidden: boolean }> = {};
    for (const [username, images] of Object.entries(accounts)) {
      result[username] = {
        hidden: hiddenAccounts.includes(username),
        eventCount: images.length,
      };
    }
    return result;
  };

  const toggleAccountHandler = (_event: Electron.IpcMainInvokeEvent, username: string, hidden: boolean) => {
    const hiddenAccounts: string[] = store.get("hiddenAccounts") || [];
    if (hidden && !hiddenAccounts.includes(username)) {
      store.set("hiddenAccounts", [...hiddenAccounts, username]);
    } else if (!hidden) {
      store.set("hiddenAccounts", hiddenAccounts.filter((a) => a !== username));
    }
  };

  accountViewerWindow = viewerWindow;

  ipcMain.handle("get-accounts", getAccountsHandler);
  ipcMain.handle("toggle-account", toggleAccountHandler);

  viewerWindow.on("closed", () => {
    ipcMain.removeHandler("get-accounts");
    ipcMain.removeHandler("toggle-account");
    accountViewerWindow = null;
  });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Kalam:wght@400;700&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'IBM Plex Sans', -apple-system, sans-serif;
          background: #f7f7f7;
          color: #162135;
          overflow-y: auto;
          padding: 32px 28px;
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #dce0e8; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #9ba3b5; }
        h2 {
          font-family: 'Kalam', cursive;
          font-weight: 700;
          font-size: 26px;
          color: #162135;
          letter-spacing: -0.3px;
          margin-bottom: 24px;
        }
        .account-row {
          display: flex;
          align-items: center;
          padding: 14px 0;
          border-bottom: 1px solid #dce0e8;
        }
        .account-row .name {
          flex: 1;
          font-size: 15px;
          font-weight: 500;
          color: #162135;
        }
        .account-row .count {
          font-size: 12px;
          color: #627296;
          margin-right: 16px;
          letter-spacing: 0.3px;
        }
        /* Toggle switch */
        .toggle {
          position: relative;
          width: 40px;
          height: 22px;
          flex-shrink: 0;
        }
        .toggle input { opacity: 0; width: 0; height: 0; }
        .toggle .slider {
          position: absolute;
          cursor: pointer;
          top: 0; left: 0; right: 0; bottom: 0;
          background: #dce0e8;
          border-radius: 11px;
          transition: background 0.25s;
        }
        .toggle .slider::before {
          content: '';
          position: absolute;
          height: 16px;
          width: 16px;
          left: 3px;
          bottom: 3px;
          background: #9ba3b5;
          border-radius: 50%;
          transition: transform 0.25s, background 0.25s;
        }
        .toggle input:checked + .slider { background: #5a32fb; }
        .toggle input:checked + .slider::before {
          transform: translateX(18px);
          background: #ffffff;
        }
        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 60vh;
          color: #627296;
          font-size: 14px;
          text-align: center;
        }
        .empty-state .title {
          font-family: 'Kalam', cursive;
          font-size: 22px;
          color: #344360;
          margin-bottom: 8px;
          font-weight: 700;
        }
      </style>
    </head>
    <body>
      <h2>Accounts</h2>
      <div id="content"></div>
      <script>
        let accounts = {};

        async function loadAccounts() {
          accounts = await window.electronAPI.getAccounts();
          render();
        }

        function render() {
          const el = document.getElementById('content');
          const sorted = Object.entries(accounts).sort((a, b) => a[0].localeCompare(b[0]));

          if (sorted.length === 0) {
            el.innerHTML = '<div class="empty-state"><div class="title">No accounts yet</div><div>Run a scan to discover events.</div></div>';
            return;
          }

          let html = '';
          sorted.forEach(([username, data]) => {
            const checked = !data.hidden ? 'checked' : '';
            html += '<div class="account-row">';
            html += '<span class="name">@' + esc(username) + '</span>';
            html += '<span class="count">' + data.eventCount + ' event' + (data.eventCount !== 1 ? 's' : '') + '</span>';
            html += '<label class="toggle"><input type="checkbox" ' + checked + ' onchange="toggle(\\'' + escJs(username) + '\\', !this.checked)" /><span class="slider"></span></label>';
            html += '</div>';
          });

          el.innerHTML = html;
        }

        function esc(s) {
          const d = document.createElement('div');
          d.textContent = s;
          return d.innerHTML;
        }

        function escJs(s) {
          return s.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
        }

        async function toggle(username, hidden) {
          await window.electronAPI.toggleAccount(username, hidden);
          accounts[username].hidden = hidden;
        }

        loadAccounts();
      </script>
    </body>
    </html>
  `;

  viewerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  viewerWindow.setMenuBarVisibility(false);
}

// --- Auto-Scan ---

async function tryAutoScan(): Promise<void> {
  if (isScanning) return;
  if (!store.get("autoScanEnabled")) return;
  if (!existsSync(getSessionPath())) return;
  if (!store.get("openrouterApiKey")) return;

  const idleTime = powerMonitor.getSystemIdleTime();
  if (idleTime > IDLE_THRESHOLD_SECONDS) return;

  const lastAuto = store.get("lastAutoScanTime") || 0;
  if (Date.now() - lastAuto < AUTO_SCAN_MIN_GAP_MS) return;

  await handleScan();
}

export function startAutoScan(): void {
  stopAutoScan();
  autoScanTimer = setInterval(() => { tryAutoScan(); }, AUTO_SCAN_INTERVAL_MS);

  powerMonitor.on("resume", () => { tryAutoScan(); });
  powerMonitor.on("unlock-screen", () => { tryAutoScan(); });
}

export function stopAutoScan(): void {
  if (autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
  }
}

function getNextAutoScanLabel(): string {
  const lastAuto = store.get("lastAutoScanTime") || 0;
  if (lastAuto === 0) return "Next: after first scan";
  const nextTime = new Date(lastAuto + AUTO_SCAN_INTERVAL_MS);
  return `Next: ~${nextTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// --- Onboarding Window ---

export function openOnboardingWindow(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }

  const preloadPath = join(__dirname, "..", "preload", "preload.js");

  onboardingWindow = new BrowserWindow({
    width: 520,
    height: 580,
    resizable: false,
    title: "Welcome to Scene Scout",
    backgroundColor: "#f7f7f7",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });

  const loginHandler = async () => {
    try {
      await runSetup();
      return { success: true };
    } catch (err) {
      return { success: false, error: `${err}` };
    }
  };

  const saveKeyHandler = (_event: Electron.IpcMainInvokeEvent, key: string) => {
    store.set("openrouterApiKey", key.trim());
    return { success: true };
  };

  const completeHandler = () => {
    store.set("onboardingComplete", true);
    onboardingWindow?.close();
    startAutoScan();
  };

  const checkSessionHandler = () => {
    return { hasSession: existsSync(getSessionPath()) };
  };

  ipcMain.handle("onboarding-login", loginHandler);
  ipcMain.handle("onboarding-save-key", saveKeyHandler);
  ipcMain.handle("onboarding-complete", completeHandler);
  ipcMain.handle("onboarding-check-session", checkSessionHandler);

  onboardingWindow.on("closed", () => {
    ipcMain.removeHandler("onboarding-login");
    ipcMain.removeHandler("onboarding-save-key");
    ipcMain.removeHandler("onboarding-complete");
    ipcMain.removeHandler("onboarding-check-session");
    onboardingWindow = null;
  });

  const currentKey = store.get("openrouterApiKey") || "";
  const hasSession = existsSync(getSessionPath());
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Kalam:wght@400;700&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'IBM Plex Sans', -apple-system, sans-serif;
          background: #f7f7f7;
          color: #162135;
          padding: 48px 44px 40px;
          user-select: none;
        }
        h1 {
          font-family: 'Kalam', cursive;
          font-weight: 700;
          font-size: 30px;
          color: #162135;
          letter-spacing: -0.3px;
          margin-bottom: 12px;
        }
        .subtitle {
          font-size: 14px;
          color: #627296;
          line-height: 1.6;
          margin-bottom: 36px;
        }
        .step { display: none; }
        .step.active { display: block; }
        label {
          display: block;
          font-size: 11px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: #627296;
          margin-bottom: 10px;
        }
        input {
          width: 100%;
          padding: 12px 14px;
          border: 1px solid #dce0e8;
          border-radius: 8px;
          background: #ffffff;
          color: #162135;
          font-family: 'IBM Plex Sans', monospace;
          font-size: 14px;
          transition: border-color 0.25s, box-shadow 0.25s;
        }
        input:focus {
          outline: none;
          border-color: #5a32fb;
          box-shadow: 0 0 0 3px rgba(90, 50, 251, 0.15);
        }
        input::placeholder { color: #9ba3b5; }
        .hint {
          font-size: 12px;
          color: #627296;
          margin-top: 10px;
        }
        .btn {
          background: #5a32fb;
          color: #ffffff;
          border: none;
          padding: 12px 32px;
          border-radius: 8px;
          cursor: pointer;
          font-family: 'IBM Plex Sans', sans-serif;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.3px;
          transition: opacity 0.2s, transform 0.1s;
          margin-top: 24px;
        }
        .btn:hover { opacity: 0.9; }
        .btn:active { transform: scale(0.97); }
        .btn:disabled { opacity: 0.5; cursor: default; transform: none; }
        .btn-secondary {
          background: transparent;
          color: #627296;
          border: 1px solid #dce0e8;
          margin-left: 12px;
        }
        .btn-secondary:hover { background: #ffffff; }
        .status {
          margin-top: 16px;
          font-size: 13px;
          color: #627296;
          min-height: 20px;
        }
        .status.success { color: #16a34a; }
        .status.error { color: #b91c1c; }
        .step-indicators {
          display: flex;
          gap: 8px;
          margin-bottom: 32px;
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #dce0e8;
          transition: background 0.3s;
        }
        .dot.active { background: #5a32fb; }
        .dot.done { background: #16a34a; }
        .buttons { display: flex; align-items: center; }
      </style>
    </head>
    <body>
      <div class="step-indicators">
        <div class="dot active" id="dot0"></div>
        <div class="dot" id="dot1"></div>
        <div class="dot" id="dot2"></div>
        <div class="dot" id="dot3"></div>
      </div>

      <div class="step active" id="step0">
        <h1>Welcome to Scene Scout</h1>
        <p class="subtitle">Scene Scout watches your Instagram stories and uses AI to find events — concerts, meetups, art shows, and more. It runs quietly in your menu bar and notifies you when new events are found.</p>
        <p class="subtitle">Let's get you set up in two quick steps.</p>
        <button class="btn" onclick="goTo(1)">Get Started</button>
      </div>

      <div class="step" id="step1">
        <h1>Instagram Login</h1>
        <p class="subtitle">Scene Scout needs an active Instagram session to view stories. A browser window will open so you can sign in.</p>
        <div class="buttons">
          <button class="btn" id="loginBtn" onclick="doLogin()">Open Instagram Login</button>
          <button class="btn btn-secondary" onclick="goTo(2)">Skip</button>
        </div>
        <div class="status" id="loginStatus">${hasSession ? '<span class="success">Session found — you are already logged in.</span>' : ''}</div>
      </div>

      <div class="step" id="step2">
        <h1>API Key</h1>
        <p class="subtitle">Scene Scout uses OpenRouter to analyze story images with AI. Paste your API key below.</p>
        <label for="apiKeyInput">OpenRouter API Key</label>
        <input type="password" id="apiKeyInput" value="${currentKey}" placeholder="sk-or-..." />
        <p class="hint">Get a key at openrouter.ai</p>
        <div class="buttons">
          <button class="btn" onclick="saveKey()">Continue</button>
        </div>
        <div class="status" id="keyStatus"></div>
      </div>

      <div class="step" id="step3">
        <h1>All set!</h1>
        <p class="subtitle">Scene Scout will automatically scan your stories every 4 hours and notify you when events are found. You can also scan manually from the menu bar icon.</p>
        <button class="btn" onclick="finish()">Start Scanning</button>
      </div>

      <script>
        let currentStep = 0;

        function goTo(step) {
          document.getElementById('step' + currentStep).classList.remove('active');
          document.getElementById('dot' + currentStep).classList.remove('active');
          document.getElementById('dot' + currentStep).classList.add('done');
          currentStep = step;
          document.getElementById('step' + currentStep).classList.add('active');
          document.getElementById('dot' + currentStep).classList.add('active');
        }

        async function doLogin() {
          const btn = document.getElementById('loginBtn');
          const status = document.getElementById('loginStatus');
          btn.disabled = true;
          btn.textContent = 'Waiting for login...';
          status.textContent = 'A browser window will open. Please sign in to Instagram.';
          status.className = 'status';

          const result = await window.electronAPI.onboardingLogin();
          if (result.success) {
            status.textContent = 'Login successful!';
            status.className = 'status success';
            btn.textContent = 'Done';
            setTimeout(() => goTo(2), 800);
          } else {
            status.textContent = 'Login failed: ' + (result.error || 'Unknown error');
            status.className = 'status error';
            btn.disabled = false;
            btn.textContent = 'Try Again';
          }
        }

        async function saveKey() {
          const input = document.getElementById('apiKeyInput');
          const status = document.getElementById('keyStatus');
          const key = input.value.trim();
          if (!key) {
            status.textContent = 'Please enter an API key.';
            status.className = 'status error';
            return;
          }
          await window.electronAPI.onboardingSaveKey(key);
          status.textContent = 'Saved!';
          status.className = 'status success';
          setTimeout(() => goTo(3), 500);
        }

        async function finish() {
          await window.electronAPI.onboardingComplete();
        }

        // Check if session already exists on load
        (async () => {
          const { hasSession } = await window.electronAPI.onboardingCheckSession();
          if (hasSession) {
            const status = document.getElementById('loginStatus');
            if (status && !status.textContent) {
              status.innerHTML = '<span class="success">Session found — you are already logged in.</span>';
            }
          }
        })();
      </script>
    </body>
    </html>
  `;

  onboardingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  onboardingWindow.setMenuBarVisibility(false);
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
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  tray.setToolTip("Scene Scout");
  tray.setContextMenu(buildMenu());
}
