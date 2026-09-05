// Readers for a bound form field. A `type="number"` input hands back a number,
// and null once it is cleared, so both are null-tolerant.

/** The field's text, trimmed; "" when it holds nothing. */
export function inputText(raw: string | number | null | undefined): string {
  return raw == null ? "" : String(raw).trim();
}

/** The field's number, or undefined when it is empty or not a number. */
export function numOrUndef(raw: string | number | null | undefined): number | undefined {
  const text = inputText(raw);
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}
