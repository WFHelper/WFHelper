// EE.log trade-dialog name sanitizers. Platform glyphs (PUA U+E000..U+F8FF)
// arrive as 1 utf8 char; pre-1.1.3 dbwin decoded them latin1 into 3-char
// mojibake runs that persist in old saved entries - strip both forms.

const PUA_GLYPHS = /[\uE000-\uF8FF\uFFFD]+/g;
const MOJIBAKE_GLYPHS = /[\u00EE\u00EF][\u0080-\u00BF]{2}/g;
const TRAILING_NON_ASCII = /[\u0080-\uFFFF]+$/;

export function stripPlatformGlyphs(value: string): string {
  return value
    .replace(PUA_GLYPHS, "")
    .replace(MOJIBAKE_GLYPHS, "")
    .replace(TRAILING_NON_ASCII, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Log framework line, not an item ("11828.904 Script [Info]: Dialog.lua: ...").
export function isLogFrameworkLine(value: string): boolean {
  return (
    /^\d+\.\d+\s/.test(value) ||
    /\[(Info|Error|Warning)\]/.test(value) ||
    /\b[A-Za-z_]+\.lua\b/.test(value)
  );
}

// Dialog::CreateOkCancel arg tail glued to the last item ("..., title= leftItem=/...").
export function stripDialogArgTail(value: string): string {
  return value.replace(/,?\s*\b(?:title|leftItem|rightItem)=.*$/i, "");
}
