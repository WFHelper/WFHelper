// Minimal, safe renderer model for GitHub release notes (Markdown).
//
// The notes come from our own GitHub release body, but we still never inject
// them as raw HTML: parseReleaseNotes turns the text into a block/segment tree
// that the changelog modal renders with plain Svelte text nodes. Links are
// restricted to http(s) at the regex level, so no javascript:/data: URLs slip
// through and there is no XSS surface.

interface InlineSegment {
  kind: "text" | "bold" | "link";
  text: string;
  href?: string;
}

type NotesBlock =
  | { kind: "heading"; level: number; segments: InlineSegment[] }
  | { kind: "paragraph"; segments: InlineSegment[] }
  | { kind: "list"; items: InlineSegment[][] };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^[-*]\s+(.*)$/;
// bold **x** | [label](http-url) | bare http-url
const INLINE_RE = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;

  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }

    if (match[1] !== undefined) {
      segments.push({ kind: "bold", text: match[1] });
    } else if (match[2] !== undefined && match[3] !== undefined) {
      segments.push({ kind: "link", text: match[2], href: match[3] });
    } else if (match[4] !== undefined) {
      // Bare URL: keep trailing sentence punctuation out of the link target.
      let url = match[4];
      const trailing = /[.,;:!?]+$/.exec(url);
      if (trailing) url = url.slice(0, -trailing[0].length);
      segments.push({ kind: "link", text: url, href: url });
      if (trailing) segments.push({ kind: "text", text: trailing[0] });
    }

    lastIndex = INLINE_RE.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }

  return segments.length ? segments : [{ kind: "text", text }];
}

export function parseReleaseNotes(raw: string): NotesBlock[] {
  const blocks: NotesBlock[] = [];
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  let paragraph: string[] = [];
  let listItems: InlineSegment[][] = [];

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    blocks.push({ kind: "paragraph", segments: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = (): void => {
    if (!listItems.length) return;
    blocks.push({ kind: "list", items: listItems });
    listItems = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        segments: parseInline(heading[2].trim()),
      });
      continue;
    }

    const list = LIST_RE.exec(trimmed);
    if (list) {
      flushParagraph();
      listItems.push(parseInline(list[1].trim()));
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks;
}
