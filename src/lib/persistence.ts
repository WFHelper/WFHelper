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
