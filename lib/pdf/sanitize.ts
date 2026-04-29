/**
 * sanitizePdfLine — strip characters outside WinAnsiEncoding so that
 * pdf-lib StandardFonts (Helvetica/HelveticaBold) never throw the
 * "WinAnsi cannot encode X (0x...)" error.
 *
 * This function is for text fields that must remain on a single line
 * (company name, item description, bank fields, etc.).  For multi-line
 * content (invoice message, bank notes) split on `\n` FIRST, then call
 * this function on each line.
 *
 * Replaces common Unicode typography with ASCII equivalents so the output
 * looks correct rather than empty:
 *   en-dash / em-dash / minus  →  -
 *   curly quotes                →  ' / "
 *   ellipsis                    →  ...
 *   non-breaking spaces         →  regular space
 *
 * Anything else outside the printable Latin-1 range (0x20–0xFF) and not
 * already handled above is removed (not replaced), which is intentional:
 * CJK, Arabic, emoji, and other multi-byte characters have no glyph in
 * Helvetica’s WinAnsiEncoding and cannot be approximated meaningfully.
 */
export function sanitizePdfLine(text: string): string {
  return text
    .replace(/[–—−]/g, '-')          // en-dash, em-dash, minus sign → hyphen
    .replace(/[‘’ʼ]/g, "'")           // left/right single quote, modifier apostrophe → '
    .replace(/[“”]/g, '"')                 // left/right double quote → "
    .replace(/…/g, '...')                       // horizontal ellipsis → ...
    .replace(/[   ]/g, ' ')           // non-breaking, narrow, thin spaces → space
    .replace(/[^\x20-\xFF]/g, '')                    // remove remaining non-Latin-1 (incl. \n, \r, \t, \0)
}
