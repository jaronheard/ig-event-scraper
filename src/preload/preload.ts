import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: Record<string, unknown>) => ipcRenderer.invoke("save-settings", settings),
});
