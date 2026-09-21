import { describe, expect, it } from "vitest";

import { APP_PRODUCT_NAME } from "../../../config/shared/appMeta.js";
import { backendClientHeader } from "../../../config/shared/backendConfig.js";

describe("backendClientHeader", () => {
  it("names the product and the version", () => {
    expect(backendClientHeader("1.4.2")).toEqual({
      "x-wfhelper-client": `${APP_PRODUCT_NAME}/1.4.2`,
    });
  });

  it("drops a leading v and surrounding whitespace", () => {
    expect(backendClientHeader(" v2.0.0-beta.1 ")).toEqual({
      "x-wfhelper-client": `${APP_PRODUCT_NAME}/2.0.0-beta.1`,
    });
  });

  it("falls back to 0.0.0 when the build carries no version", () => {
    expect(backendClientHeader(undefined)).toEqual({
      "x-wfhelper-client": `${APP_PRODUCT_NAME}/0.0.0`,
    });
    expect(backendClientHeader("")).toEqual({
      "x-wfhelper-client": `${APP_PRODUCT_NAME}/0.0.0`,
    });
  });
});
