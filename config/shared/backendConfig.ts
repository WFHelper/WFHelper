import { APP_PRODUCT_NAME } from "./appMeta";

/** Default backend Worker URL; renderer overrides via VITE_WFM_BACKEND_URL. */
export const BACKEND_URL = "https://api.wfhelper.com";

const CLIENT_HEADER = "x-wfhelper-client";

/** Identifies the build to the backend as `<product>/<version>`. The product comes
 *  from appMeta, so a fork keeping this backend announces its own name. */
export function backendClientHeader(version?: string | null): Record<string, string> {
  const normalized = (version || "").trim().replace(/^v/i, "");
  return { [CLIENT_HEADER]: `${APP_PRODUCT_NAME}/${normalized || "0.0.0"}` };
}
