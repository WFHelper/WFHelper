import { describe, it, expect } from "vitest";
import { parseReleaseNotes } from "../../../src/lib/releaseNotes.js";

describe("parseReleaseNotes", () => {
  it("parses headings and list items", () => {
    const blocks = parseReleaseNotes("## What's Changed\n- Added foo\n- Fixed bar");

    const heading = blocks[0];
    expect(heading.kind).toBe("heading");
    if (heading.kind === "heading") {
      expect(heading.level).toBe(2);
      expect(heading.segments[0].text).toBe("What's Changed");
    }

    const list = blocks[1];
    expect(list.kind).toBe("list");
    if (list.kind === "list") {
      expect(list.items).toHaveLength(2);
      expect(list.items[0][0].text).toBe("Added foo");
    }
  });

  it("keeps bold spans and bare URLs as separate segments", () => {
    const blocks = parseReleaseNotes("**Full Changelog**: https://github.com/o/r/compare/v1...v2");
    const segments = blocks[0].kind === "paragraph" ? blocks[0].segments : [];

    expect(segments[0]).toMatchObject({ kind: "bold", text: "Full Changelog" });
    const link = segments.find((s) => s.kind === "link");
    expect(link?.href).toBe("https://github.com/o/r/compare/v1...v2");
  });

  it("parses markdown links", () => {
    const blocks = parseReleaseNotes("See [the docs](https://example.com/docs) now");
    const segments = blocks[0].kind === "paragraph" ? blocks[0].segments : [];

    const link = segments.find((s) => s.kind === "link");
    expect(link).toMatchObject({
      kind: "link",
      text: "the docs",
      href: "https://example.com/docs",
    });
  });

  it("never links non-http(s) schemes", () => {
    const blocks = parseReleaseNotes("[click](javascript:alert(1)) and mailto:x@y.z");
    const segments = blocks[0].kind === "paragraph" ? blocks[0].segments : [];

    expect(segments.every((s) => s.kind !== "link")).toBe(true);
  });

  it("converts an html release body to blocks instead of showing raw tags", () => {
    const blocks = parseReleaseNotes(
      '<p>To update: click the pill.</p> <h3>Fixes</h3> <ul> <li>Riven scan: fixed <code>crop</code></li> <li>See <a href="https://example.com/x">notes</a></li> </ul>',
    );

    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
    expect(blocks[1]).toMatchObject({ kind: "heading", level: 3 });
    const list = blocks[2];
    expect(list.kind).toBe("list");
    if (list.kind === "list") {
      expect(list.items[0][0].text).toBe("Riven scan: fixed crop");
      expect(list.items[1].find((s) => s.kind === "link")?.href).toBe("https://example.com/x");
    }
    const allText = JSON.stringify(blocks);
    expect(allText).not.toContain("<");
  });

  it("leaves markdown bodies containing angle brackets untouched", () => {
    const blocks = parseReleaseNotes("Values below <threshold> are dropped");
    expect(blocks[0].kind === "paragraph" && blocks[0].segments[0].text).toContain("<threshold>");
  });

  it("strips trailing sentence punctuation from bare URLs", () => {
    const blocks = parseReleaseNotes("Visit https://a.com/x. Thanks");
    const segments = blocks[0].kind === "paragraph" ? blocks[0].segments : [];

    const link = segments.find((s) => s.kind === "link");
    expect(link?.href).toBe("https://a.com/x");
    expect(segments.some((s) => s.kind === "text" && s.text.includes("."))).toBe(true);
  });
});
