/**
 * Shared error-message normalizer used by main-process, IPC handlers,
 * renderer, and (optionally) the worker.
 *
 * Centralizes the pattern of safely extracting a human-readable message
 * from an unknown caught value.
 */

/**
 * Extract a human-readable error message from an unknown caught value.
 *
 * - If `err` is an object with a string `.message`, returns that (trimmed).
 * - If `err` is a non-empty string, returns it (trimmed).
 * - Otherwise returns `fallback`.
 *
 * This is intentionally more permissive than `err instanceof Error` so it
 * works with duck-typed error objects from other contexts (e.g. Electron IPC,
 * Cloudflare Workers).
 */
export function normalizeErrorMessage(err: unknown, fallback: string = "Unknown error"): string {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    const message = (err as { message: string }).message.trim();
    if (message) return message;
  }
  if (typeof err === "string" && err.trim()) {
    return err.trim();
  }
  return fallback;
}
