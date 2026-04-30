import { describe, expect, it } from "vitest";

import { toIconMirrorUrl } from "../../services/iconMirror";

describe("icon mirror URLs", () => {
  it("maps source URLs to deterministic mirrored asset URLs", () => {
    expect(
      toIconMirrorUrl(
        "https://browse.wf/Lotus/Interface/Icons/StoreIcons/Weapons/PrimaryWeapons/Weapons/BoarPrime.png",
      ),
    ).toBe("https://assets.wfhelper.com/icons/f79f9d2264f511aceb6c4358.png");
  });

  it("does not remap already mirrored URLs", () => {
    const mirrored = "https://assets.wfhelper.com/icons/f79f9d2264f511aceb6c4358.png";

    expect(toIconMirrorUrl(mirrored)).toBe(mirrored);
  });
});
