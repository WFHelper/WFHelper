import type { PreloadAPI, TradePreloadAPI } from "./preload.js";

declare global {
  interface Window {
    api: PreloadAPI;
    tradeApi: TradePreloadAPI;
  }

  interface ImportMetaEnv {
    readonly MODE: string;
    readonly VITE_APP_VERSION?: string;
    readonly VITE_WFM_BACKEND_URL?: string;
    readonly VITE_WFM_BACKEND_DIRECT_FALLBACK?: "always" | "high" | "never";
    readonly VITE_WFM_BACKEND_BOOTSTRAP_ENABLED?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
