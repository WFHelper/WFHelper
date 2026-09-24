import fs from "node:fs";

import { normalizeErrorMessage } from "../config/shared/errors";
import { writeFileAtomicSync } from "./atomicFile";
import { withScope } from "./logger";
import { userDataPath } from "./userDataPath";

const log = withScope("jsonCache");

type JsonCacheLoad<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  /** The read itself failed, so the file may still be intact. */
  | { status: "unreadable"; error: string }
  /** Not JSON, or JSON that `revive` rejects. */
  | { status: "invalid" };

interface JsonCache<T> {
  read(): T | null;
  load(): JsonCacheLoad<T>;
  quarantine(): boolean;
  write(payload: T): void;
}

/** Renames a file aside to `<file>.corrupt-<ms>` so a later write cannot replace the only copy. */
export function quarantineFile(filePath: string): boolean {
  const backup = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, backup);
    log.warn(`Unreadable ${filePath} moved to ${backup}`);
    return true;
  } catch (err) {
    log.warn(`Could not move unreadable ${filePath} aside: ${normalizeErrorMessage(err)}`);
    return false;
  }
}

// `revive` owns shape validation; an unreadable file and a failed write both
// degrade so a corrupt cache never blocks a rebuild from source.
export function createJsonCache<T>(
  filename: string,
  revive: (parsed: unknown) => T | null,
): JsonCache<T> {
  const cachePath = (): string => userDataPath(filename);

  function load(): JsonCacheLoad<T> {
    let text: string;
    try {
      text = fs.readFileSync(cachePath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "unreadable", error: normalizeErrorMessage(err) };
    }
    try {
      const value = revive(JSON.parse(text));
      return value === null ? { status: "invalid" } : { status: "ok", value };
    } catch {
      return { status: "invalid" };
    }
  }

  return {
    read(): T | null {
      const loaded = load();
      return loaded.status === "ok" ? loaded.value : null;
    },
    load,
    quarantine: () => quarantineFile(cachePath()),
    write(payload: T): void {
      try {
        writeFileAtomicSync(cachePath(), JSON.stringify(payload));
      } catch (err) {
        log.warn(`Failed to write ${filename}`, err);
      }
    },
  };
}
