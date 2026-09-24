const PRUNE_ABOVE = 64;

interface EchoFilter {
  isEcho(key: string, now: number): boolean;
  clear(): void;
}

/** A key seen again within windowMs of its last sighting is an echo; every sighting counts. */
export function createEchoFilter(windowMs: number): EchoFilter {
  const lastSeen = new Map<string, number>();
  return {
    isEcho(key, now) {
      const previous = lastSeen.get(key);
      lastSeen.set(key, now);
      if (lastSeen.size > PRUNE_ABOVE) {
        for (const [seen, at] of lastSeen) {
          if (now - at >= windowMs) lastSeen.delete(seen);
        }
      }
      return previous !== undefined && now - previous < windowMs;
    },
    clear() {
      lastSeen.clear();
    },
  };
}
