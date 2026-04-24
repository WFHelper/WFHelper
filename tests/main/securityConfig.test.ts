import { describe, expect, it } from "vitest";

import { toAllowedConnectOrigin } from "../../config/runtime/security";

describe("runtime security config", () => {
  it("only allows http/https localhost origins and https remote origins", () => {
    expect(toAllowedConnectOrigin("ftp://localhost:8080")).toBeNull();
    expect(toAllowedConnectOrigin("file://localhost")).toBeNull();
    expect(toAllowedConnectOrigin("ws://localhost:3000")).toBeNull();
    expect(toAllowedConnectOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(toAllowedConnectOrigin("https://localhost:5173")).toBe("https://localhost:5173");
    expect(toAllowedConnectOrigin("https://example.com/path")).toBe("https://example.com");
    expect(toAllowedConnectOrigin("http://example.com")).toBeNull();
  });
});
