/** Narrows IPC results that came back as `{ error: string }` instead of the happy-path payload. */
export function isIpcError(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "string"
  );
}
