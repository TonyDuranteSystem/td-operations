/**
 * Parse the ITIN issue date from CP565 notice OCR text.
 *
 * CP565 notices have a date in "Month DD, YYYY" format near the ITIN assignment text.
 * Falls back to today's date if no date is found.
 */

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
}

export function parseItinIssueDateFromOcr(ocrText: string): string {
  const today = new Date().toISOString().split("T")[0]

  // Pattern: "Month DD, YYYY" — standard IRS CP565 date format
  // Look for dates near ITIN-related text for accuracy
  const monthNames = Object.keys(MONTHS).join("|")
  const datePattern = new RegExp(
    `(${monthNames})\\s+(\\d{1,2}),?\\s+(\\d{4})`,
    "gi"
  )

  // Collect all date matches
  const matches: { match: RegExpExecArray; index: number }[] = []
  let m: RegExpExecArray | null
  while ((m = datePattern.exec(ocrText)) !== null) {
    matches.push({ match: m, index: m.index })
  }
  if (matches.length === 0) return today

  // If there's ITIN assignment text, prefer the date closest to it
  const itinIndex = ocrText.search(/(?:assigned|ITIN\s+\d{3})/i)

  let best = matches[0]
  if (itinIndex >= 0 && matches.length > 1) {
    let minDistance = Infinity
    for (const entry of matches) {
      const dist = Math.abs(entry.index - itinIndex)
      if (dist < minDistance) {
        minDistance = dist
        best = entry
      }
    }
  }

  const month = MONTHS[best.match[1].toLowerCase()]
  const day = best.match[2].padStart(2, "0")
  const year = best.match[3]

  if (!month || !year) return today

  return `${year}-${month}-${day}`
}
