import { describe, expect, it } from "vitest";

import { parseWhisperUsername } from "../../services/eeLogMonitor";

describe("parseWhisperUsername", () => {
  const line = (channel: string) =>
    `123.456 Sys [Info]: ChatRedux::AddTab: Adding tab with channel name: ${channel} to index 4`;

  it("extracts the username from a whisper tab (F prefix)", () => {
    expect(parseWhisperUsername(line("FSomePlayer"))).toBe("SomePlayer");
  });

  it("strips a trailing non-ASCII platform glyph", () => {
    expect(parseWhisperUsername(line("FConsoleDude★"))).toBe("ConsoleDude");
  });

  it("ignores non-whisper tabs (no F prefix)", () => {
    expect(parseWhisperUsername(line("Region"))).toBeNull();
    expect(parseWhisperUsername(line("CClanChat"))).toBeNull();
  });

  it("returns null for unrelated log lines", () => {
    expect(parseWhisperUsername("123 Sys [Info]: Pause countdown done")).toBeNull();
    expect(parseWhisperUsername("ChatRedux::AddTab: Adding tab with channel name: F")).toBeNull();
  });
});
