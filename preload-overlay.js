const { contextBridge, ipcRenderer } = require("electron");

// Minimal API surface exposed to the relic reward overlay window.
contextBridge.exposeInMainWorld("overlay", {
  // Close/hide the overlay
  close: () => ipcRenderer.send("overlay-close"),

  // Fetch all unique reward items from the relic DB for search autocomplete
  getRelicItems: () => ipcRenderer.invoke("overlay-get-relic-items"),

  // Listen for relic reward trigger from EE.log (overlay should show scanning state)
  onTrigger: (cb) => ipcRenderer.on("relic-reward-trigger", () => cb()),

  // Receive auto-detected reward items from the OCR scanner.
  // items: Array<{name, urlName, rarity}> — empty array means detection failed (show manual mode)
  onItems: (cb) => ipcRenderer.on("relic-reward-items", (_e, items) => cb(items)),
});
