/**
 * Measures how stale an EE.log line is when it reaches us. The engine buffers
 * log writes; at quiet moments (staring at a reward screen) a line can hit the
 * file 10-15s after the event it describes. Each line carries a game-uptime
 * prefix ("5160.682 Sys [Info]: ..."); tracking the minimum of wallclock-uptime
 * across lines gives the true offset, and a line's staleness is how far its
 * own wallclock-uptime sits above that minimum.
 */

const UPTIME_PREFIX = /^(\d+)\.(\d{3}) /;

export class EeUptimeTracker {
  private offsetMs: number | null = null;
  private lastUptimeMs = 0;
  private lastStalenessMs = 0;

  reset(): void {
    this.offsetMs = null;
    this.lastUptimeMs = 0;
    this.lastStalenessMs = 0;
  }

  /**
   * Feed one file line; returns its staleness in ms (0 while unknown).
   * Unstamped lines (JSON block rows) inherit the batch's last staleness.
   */
  observe(line: string, nowMs: number): number {
    const m = UPTIME_PREFIX.exec(line);
    if (!m) return this.lastStalenessMs;

    const uptimeMs = Number(m[1]) * 1000 + Number(m[2]);
    if (uptimeMs < this.lastUptimeMs - 5_000) this.offsetMs = null; // game restarted
    this.lastUptimeMs = uptimeMs;

    const offset = nowMs - uptimeMs;
    if (this.offsetMs === null || offset < this.offsetMs) this.offsetMs = offset;
    this.lastStalenessMs = Math.max(0, offset - this.offsetMs);
    return this.lastStalenessMs;
  }
}
