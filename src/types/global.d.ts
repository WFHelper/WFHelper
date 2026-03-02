import type { PreloadAPI } from "./preload.js";

declare global {
  interface Window {
    api: PreloadAPI;
  }

  interface ImportMetaEnv {
    readonly MODE: string;
    readonly VITE_APP_VERSION?: string;
    readonly VITE_SENTRY_DSN?: string;
    readonly VITE_SENTRY_RELEASE?: string;
    readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
