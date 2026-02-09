import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: Record<string, unknown>) => ipcRenderer.invoke("save-settings", settings),
  getAccounts: () => ipcRenderer.invoke("get-accounts"),
  toggleAccount: (username: string, hidden: boolean) => ipcRenderer.invoke("toggle-account", username, hidden),
  getUnreviewedEvents: () => ipcRenderer.invoke("get-unreviewed-events"),
  reviewEvent: (key: string, approved: boolean) => ipcRenderer.invoke("review-event", key, approved),
  hideAccount: (username: string) => ipcRenderer.invoke("hide-account", username),
  unhideAccount: (username: string) => ipcRenderer.invoke("unhide-account", username),
  exportEvents: () => ipcRenderer.invoke("export-events"),
  copyAndOpenSoonlist: () => ipcRenderer.invoke("copy-and-open-soonlist"),
  getReviewHistory: () => ipcRenderer.invoke("get-review-history"),
  onboardingLogin: () => ipcRenderer.invoke("onboarding-login"),
  onboardingSaveKey: (key: string) => ipcRenderer.invoke("onboarding-save-key", key),
  onboardingComplete: () => ipcRenderer.invoke("onboarding-complete"),
  onboardingCheckSession: () => ipcRenderer.invoke("onboarding-check-session"),
});
