import { writable, type Writable } from "svelte/store";

export function readStorage(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    /* best effort */
  }
}

/** Revive path shared by the JSON-backed stores: a missing or blank key and text
 *  that does not parse both take the fallback, anything else meets the caller's
 *  normalizer, which stays the only place a store's own shape rules live. */
export function readStoredJson<T>(
  key: string,
  normalize: (parsed: unknown) => T,
  fallback: () => T,
  onUnreadable?: () => void,
): T {
  const raw = readStorage(key);
  if (raw == null || raw.trim() === "") return fallback();
  try {
    return normalize(JSON.parse(raw));
  } catch {
    onUnreadable?.();
    return fallback();
  }
}

export function persistedString<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): Writable<T> {
  const raw = readStorage(key);
  const initial = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const store = writable<T>(initial);

  return {
    subscribe: store.subscribe,
    set(value: T): void {
      writeStorage(key, value);
      store.set(value);
    },
    update(fn: (value: T) => T): void {
      store.update((current) => {
        const next = fn(current);
        writeStorage(key, next);
        return next;
      });
    },
  };
}

/**
 * Numeric twin of persistedString. A value outside the preset list, including a
 * hand-edited one, falls back rather than filtering by a number no button shows.
 */
export function persistedPresetNumber(
  key: string,
  allowed: readonly number[],
  fallback: number,
): Writable<number> {
  const normalize = (value: number): number => (allowed.includes(value) ? value : fallback);
  const raw = readStorage(key);
  const store = writable<number>(normalize(raw == null ? Number.NaN : Number(raw)));
  const save = (value: number) => writeStorage(key, String(value));

  return {
    subscribe: store.subscribe,
    set(value: number): void {
      const next = normalize(value);
      save(next);
      store.set(next);
    },
    update(fn: (value: number) => number): void {
      store.update((current) => {
        const next = normalize(fn(current));
        save(next);
        return next;
      });
    },
  };
}

export function persistedStringList(key: string, max = 20): Writable<string[]> {
  let initial: string[] = [];
  try {
    const parsed = JSON.parse(readStorage(key) || "[]");
    if (Array.isArray(parsed)) {
      initial = parsed.filter((v): v is string => typeof v === "string").slice(-max);
    }
  } catch {
    /* corrupted - start empty */
  }
  const store = writable<string[]>(initial);
  const save = (list: string[]) => writeStorage(key, JSON.stringify(list));

  return {
    subscribe: store.subscribe,
    set(value: string[]): void {
      // Keep the newest entries: additions append, so trimming the front
      // drops the oldest instead of silently ignoring new ones at the cap.
      const next = value.slice(-max);
      save(next);
      store.set(next);
    },
    update(fn: (value: string[]) => string[]): void {
      store.update((current) => {
        const next = fn(current).slice(-max);
        save(next);
        return next;
      });
    },
  };
}

export function persistedBoolean(key: string, fallback: boolean): Writable<boolean> {
  const raw = readStorage(key);
  const initial = raw == null ? fallback : raw === "1";
  const store = writable<boolean>(initial);

  return {
    subscribe: store.subscribe,
    set(value: boolean): void {
      writeStorage(key, value ? "1" : "0");
      store.set(value);
    },
    update(fn: (value: boolean) => boolean): void {
      store.update((current) => {
        const next = fn(current);
        writeStorage(key, next ? "1" : "0");
        return next;
      });
    },
  };
}
