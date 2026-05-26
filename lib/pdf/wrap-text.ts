/**
 * Word-wrap a string to a list of lines that each fit within `maxWidth`,
 * measured with a pdf-lib font (or any object exposing widthOfTextAtSize).
 *
 * Used by invoice PDF rendering so long line-item descriptions wrap onto
 * multiple lines instead of being hard-truncated. Caller controls vertical
 * layout by iterating the returned lines.
 */

export interface TextMeasurer {
  widthOfTextAtSize(text: string, size: number): number
}

export interface WrapOptions {
  /** Hard cap on number of lines. The last kept line is ellipsized if more text remains. Default: no cap. */
  maxLines?: number
}

/**
 * Break a single token that is itself wider than maxWidth into width-fitting chunks.
 * Prevents one space-less token (e.g. a long URL or handle) from overflowing the column.
 */
function breakLongToken(
  token: string,
  font: TextMeasurer,
  size: number,
  maxWidth: number,
): string[] {
  const chunks: string[] = []
  let current = ''
  for (const char of token) {
    const test = current + char
    if (current && font.widthOfTextAtSize(test, size) > maxWidth) {
      chunks.push(current)
      current = char
    } else {
      current = test
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export function wrapPdfText(
  text: string,
  font: TextMeasurer,
  size: number,
  maxWidth: number,
  options: WrapOptions = {},
): string[] {
  if (!text || maxWidth <= 0) return []

  const rawWords = text.split(/\s+/).filter(Boolean)

  // Expand any token that on its own exceeds maxWidth into smaller pieces.
  const words: string[] = []
  for (const word of rawWords) {
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      words.push(...breakLongToken(word, font, size, maxWidth))
    } else {
      words.push(word)
    }
  }

  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (line && font.widthOfTextAtSize(test, size) > maxWidth) {
      lines.push(line)
      line = word
    } else {
      line = test
    }
  }
  if (line) lines.push(line)

  const maxLines = options.maxLines
  if (maxLines !== undefined && maxLines > 0 && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    let last = kept[maxLines - 1]
    // Make room for the ellipsis within maxWidth.
    while (last.length > 0 && font.widthOfTextAtSize(`${last}...`, size) > maxWidth) {
      last = last.slice(0, -1)
    }
    kept[maxLines - 1] = `${last}...`
    return kept
  }

  return lines
}
