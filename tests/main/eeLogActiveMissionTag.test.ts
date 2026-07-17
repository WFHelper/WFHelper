import { describe, expect, it } from "vitest";

import { parseActiveMissionTag } from "../../services/eeLogMonitor";

describe("parseActiveMissionTag", () => {
  it("parses the key=value mission-info block form", () => {
    expect(parseActiveMissionTag("    activeMissionTag=VoidT6")).toBe("VoidT6");
    expect(parseActiveMissionTag("activeMissionTag=VoidT1")).toBe("VoidT1");
  });

  it("parses the JSON block form", () => {
    expect(parseActiveMissionTag('    "activeMissionTag" : "VoidT5",')).toBe("VoidT5");
    expect(parseActiveMissionTag('{"activeMissionTag":"VoidT2"}')).toBe("VoidT2");
  });

  it("ignores unrelated and empty lines", () => {
    expect(parseActiveMissionTag("    activeMissionId=SolNode717_6a59dee6")).toBeNull();
    expect(parseActiveMissionTag("activeMissionTag=")).toBeNull();
    expect(parseActiveMissionTag("123.4 Sys [Info]: nothing here")).toBeNull();
  });
});
