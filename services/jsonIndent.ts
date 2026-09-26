const INDENT = "  ";

function isJsonSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}

function isJsonBoundary(ch: string): boolean {
  return ch === "" || isJsonSpace(ch) || ',:{}[]"'.includes(ch);
}

/** Lays out valid JSON text the way JSON.stringify(value, null, 2) does, without
 *  parsing it, so integers beyond 2^53 (inventory seeds, nemesis fp) keep every digit. */
export function indentJsonText(text: string): string {
  const parts: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text.charAt(end) !== '"') {
        end += text.charAt(end) === "\\" ? 2 : 1;
      }
      parts.push(text.slice(i, end + 1));
      i = end + 1;
    } else if (ch === "{" || ch === "[") {
      let next = i + 1;
      while (isJsonSpace(text.charAt(next))) next += 1;
      if (text.charAt(next) === (ch === "{" ? "}" : "]")) {
        parts.push(ch, text.charAt(next));
        i = next + 1;
      } else {
        depth += 1;
        parts.push(ch, "\n", INDENT.repeat(depth));
        i += 1;
      }
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      parts.push("\n", INDENT.repeat(depth), ch);
      i += 1;
    } else if (ch === ",") {
      parts.push(",\n", INDENT.repeat(depth));
      i += 1;
    } else if (ch === ":") {
      parts.push(": ");
      i += 1;
    } else if (isJsonSpace(ch)) {
      i += 1;
    } else {
      let end = i + 1;
      while (!isJsonBoundary(text.charAt(end))) end += 1;
      parts.push(text.slice(i, end));
      i = end;
    }
  }
  return parts.join("");
}
