import path from "node:path";

export function normalizePathForCompare(filePath: unknown): string {
  return path
    .normalize(String(filePath || ""))
    .replace(/\\+/g, "/")
    .toLowerCase();
}
