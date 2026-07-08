/**
 * Plain-text email helpers shared by the reply sender (HTML part building)
 * and the thread renderer (Gmail-style "Show quoted text" collapsing).
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export interface SplitQuotedResult {
  /** The new content of the message (above the quoted history) */
  main: string
  /** The quoted history ("On ... wrote:" + "> " lines), or null if none */
  quoted: string | null
}

/**
 * Split a plain-text email into the fresh content and the quoted history,
 * the way Gmail hides history behind the "···" toggle. Detects either an
 * "On <...> wrote:" attribution line followed by "> " lines, or a trailing
 * block of "> " lines. Conservative: when unsure, everything stays in main.
 */
export function splitQuotedText(text: string): SplitQuotedResult {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd()
    const isAttribution =
      /^On .{5,200} wrote:$/.test(line) || /^Il .{5,200} ha scritto:$/.test(line)
    const isQuoteLine = line.startsWith(">")
    if (!isAttribution && !isQuoteLine) continue
    // An attribution must be followed (possibly after blanks) by "> " lines;
    // a bare quote block must run to the end of the message.
    let j = i + (isAttribution ? 1 : 0)
    while (j < lines.length && lines[j].trim() === "") j++
    if (isAttribution && !(j < lines.length && lines[j].startsWith(">"))) continue
    const rest = lines.slice(j)
    const isQuoteBlock = rest.every(
      (l) => l.startsWith(">") || l.trim() === ""
    )
    if (!isQuoteBlock) continue
    const main = lines.slice(0, i).join("\n").trimEnd()
    const quoted = lines.slice(i).join("\n").trimEnd()
    if (!quoted) continue
    return { main, quoted }
  }
  return { main: text, quoted: null }
}
