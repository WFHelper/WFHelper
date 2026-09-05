import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/wfmClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/wfmClient")>();
  return { ...actual, request: vi.fn() };
});

import { request, WfmApiError } from "../../services/wfmClient";
import { sendPlusRep } from "../../services/wfmReviews";

const requestMock = vi.mocked(request);

describe("sendPlusRep", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("posts a text-free +1 review to the partner's profile", async () => {
    requestMock.mockResolvedValueOnce({});

    await expect(sendPlusRep("PureFPSZac")).resolves.toBe("sent");
    expect(requestMock).toHaveBeenCalledWith("POST", "/profile/purefpszac/review", {
      json: { review_type: 1, text: "" },
    });
  });

  it("url-encodes the partner name", async () => {
    requestMock.mockResolvedValueOnce({});

    await sendPlusRep("Some Name");
    expect(requestMock).toHaveBeenCalledWith("POST", "/profile/some%20name/review", {
      json: { review_type: 1, text: "" },
    });
  });

  it("maps WFM's duplicate-review error", async () => {
    requestMock.mockRejectedValueOnce(
      new WfmApiError("WFMClient API error: app.review.already_exist", "WFM_API_ERROR", 400),
    );

    await expect(sendPlusRep("Buyer")).resolves.toBe("already-exists");
  });

  it("maps a 404 to user-not-found", async () => {
    requestMock.mockRejectedValueOnce(new WfmApiError("HTTP 404", "WFM_API_ERROR", 404));

    await expect(sendPlusRep("NoSuchUser")).resolves.toBe("user-not-found");
  });

  it("maps anything else to failed", async () => {
    requestMock.mockRejectedValueOnce(new Error("network down"));

    await expect(sendPlusRep("Buyer")).resolves.toBe("failed");
  });

  it("refuses an empty partner name without calling WFM", async () => {
    await expect(sendPlusRep("   ")).resolves.toBe("failed");
    expect(requestMock).not.toHaveBeenCalled();
  });
});
