import Store from "electron-store";

export interface ReviewHistoryEntry {
  timestamp: string;
  accounts: string[];
  approvedCount: number;
  rejectedCount: number;
}

interface StoreSchema {
  openrouterApiKey: string;
  licenseKey: string;
  lastScanTime: string;
  lastEventCount: number;
  lastStoryCount: number;
  lastError: string;
  hiddenAccounts: string[];
  reviewedEvents: string[];
  rejectedEvents: string[];
  soonlistUsername: string;
  onboardingComplete: boolean;
  autoScanEnabled: boolean;
  lastAutoScanTime: number;
  reviewHistory: ReviewHistoryEntry[];
}

const store = new Store<StoreSchema>({
  defaults: {
    openrouterApiKey: "",
    licenseKey: "",
    lastScanTime: "",
    lastEventCount: 0,
    lastStoryCount: 0,
    lastError: "",
    hiddenAccounts: [],
    reviewedEvents: [],
    rejectedEvents: [],
    soonlistUsername: "",
    onboardingComplete: false,
    autoScanEnabled: true,
    lastAutoScanTime: 0,
    reviewHistory: [],
  },
});

export default store;
