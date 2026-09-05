import { beforeEach, describe, expect, it, vi } from "vitest";

import { request, requestV2 } from "../../services/wfmClient";
import { WfmApiError } from "../../services/wfmTypes";
import { deleteRivenAuction } from "../../services/wfmRivenSearch";

vi.mock("../../services/wfmClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/wfmClient")>();
  return { ...actual, request: vi.fn(), requestV2: vi.fn() };
});

const requestMock = vi.mocked(request);
const requestV2Mock = vi.mocked(requestV2);

function apiError(label: string, detail: string, status: number): WfmApiError {
  return new WfmApiError(`${label} API error: ${detail}`, "WFM_API_ERROR", status);
}

describe("deleteRivenAuction", () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestV2Mock.mockReset();
  });

  it("removes the listing through the v1 close route", async () => {
    requestMock.mockResolvedValueOnce(null);

    await expect(deleteRivenAuction("a1")).resolves.toEqual({ ok: true });
    expect(requestMock).toHaveBeenCalledWith("PUT", "/auctions/entry/a1/close");
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestV2Mock).not.toHaveBeenCalled();
  });

  it("encodes the auction id", async () => {
    requestMock.mockResolvedValueOnce(null);

    await deleteRivenAuction("a/2");
    expect(requestMock).toHaveBeenCalledWith("PUT", "/auctions/entry/a%2F2/close");
  });

  // A 404 is a stale or foreign auction id. Escalating it to a second route
  // would send another account-mutating request on the user's behalf.
  it("reports a missing auction without sending a second mutating call", async () => {
    requestMock.mockRejectedValueOnce(apiError("WFMClient", "Not found", 404));

    const result = await deleteRivenAuction("a3");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Not found");
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestV2Mock).not.toHaveBeenCalled();
  });

  it("reports a refused method without sending a second mutating call", async () => {
    requestMock.mockRejectedValueOnce(apiError("WFMClient", "Method not allowed: PUT", 405));

    const result = await deleteRivenAuction("a4");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Method not allowed");
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestV2Mock).not.toHaveBeenCalled();
  });

  it("reports an authorization refusal", async () => {
    requestMock.mockRejectedValueOnce(apiError("WFMClient", "app.form.not_authorized", 403));

    const result = await deleteRivenAuction("a5");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("app.form.not_authorized");
    expect(requestV2Mock).not.toHaveBeenCalled();
  });
});
