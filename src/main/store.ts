import Store from "electron-store";

interface StoreSchema {
  openrouterApiKey: string;
  licenseKey: string;
  lastScanTime: string;
  lastEventCount: number;
}

const store = new Store<StoreSchema>({
  defaults: {
    openrouterApiKey: "",
    licenseKey: "",
    lastScanTime: "",
    lastEventCount: 0,
  },
});

export default store;
