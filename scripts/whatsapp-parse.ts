/**
 * Pure parsing/matching helpers for the WhatsApp export importer.
 *
 * Kept side-effect free (no env reads, no DB/Drive clients) so the logic that
 * decides message direction, media detection, phone matching, and display names
 * can be unit-tested in isolation. The CLI runner lives in `import-whatsapp.ts`.
 */

// ─── Message line regex ──────────────────────────────────
// Format: 2025/01/15, 14:23:45 - 393332903858: text
export const MSG_REGEX = /^(\d{4}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2}) - (\d+): (.+)$/
// Timestamp prefix (to detect system lines vs continuation)
export const TS_PREFIX_REGEX = /^\d{4}\/\d{2}\/\d{2}, \d{2}:\d{2}:\d{2} - /
// Media content patterns
export const MEDIA_REGEX = /‎?(image|video|audio|sticker|document|GIF|contact card) omitted$/i

export interface ParsedMessage {
  timestamp: Date
  senderPhone: string
  content: string
  direction: 'inbound' | 'outbound'
  contentType: 'text' | 'media'
}

/**
 * Parse a normalized WhatsApp export. Each message line is
 * `YYYY/MM/DD, HH:MM:SS - <digits>: text`; continuation lines (no timestamp)
 * are appended to the previous message; timestamped lines without a digit
 * sender are treated as system lines and skipped. Direction is outbound when
 * the sender's digits equal the firm's own number.
 */
export function parseExport(text: string, _filePhone: string, firmDigits: string): ParsedMessage[] {
  const lines = text.split('\n')
  const messages: ParsedMessage[] = []
  let current: ParsedMessage | null = null

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    const match = MSG_REGEX.exec(line)
    if (match) {
      // Flush previous message
      if (current) messages.push(current)

      const [, tsStr, senderDigits, content] = match
      // Parse timestamp: "2025/01/15, 14:23:45"
      const [datePart, timePart] = tsStr.split(', ')
      const [year, month, day] = datePart.split('/')
      const [hour, minute, second] = timePart.split(':')
      const ts = new Date(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        parseInt(hour), parseInt(minute), parseInt(second)
      )

      const isMedia = MEDIA_REGEX.test(content)
      current = {
        timestamp: ts,
        senderPhone: senderDigits,
        content,
        direction: senderDigits === firmDigits ? 'outbound' : 'inbound',
        contentType: isMedia ? 'media' : 'text',
      }
    } else if (TS_PREFIX_REGEX.test(line)) {
      // Has timestamp but no digit sender → system line, skip
      if (current) messages.push(current)
      current = null
    } else if (line.trim() && current) {
      // Continuation of previous message
      current.content += '\n' + line
    }
  }
  if (current) messages.push(current)
  return messages
}

// ─── Phone matching ───────────────────────────────────────
export function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}

// Suffix matching is gated by a minimum length so a short stored number can't
// match many different exports (false-positive client attachment).
export const MIN_MATCH_DIGITS = 8

/**
 * True when a CRM phone (any format) refers to the same number as the export's
 * digits. Exact digit match, or a country-code-tolerant shared trailing-digit
 * match (up to 10 digits) when both numbers are long enough to be unambiguous.
 */
export function phonesMatch(dbPhone: string | null | undefined, fileDigits: string): boolean {
  if (!dbPhone || !fileDigits) return false
  const dbDigits = digitsOnly(dbPhone)
  if (!dbDigits) return false
  // Exact match
  if (dbDigits === fileDigits) return true
  // Country-code-tolerant suffix match: both must be long enough, and we compare
  // the shared trailing digits (up to 10) so e.g. 3933290... matches 393332903858.
  if (dbDigits.length < MIN_MATCH_DIGITS || fileDigits.length < MIN_MATCH_DIGITS) return false
  const n = Math.min(dbDigits.length, fileDigits.length, 10)
  return dbDigits.slice(-n) === fileDigits.slice(-n)
}

// Display name from a contact/lead row: full_name preferred, else first + last.
export function personName(p: {
  full_name?: string | null
  first_name?: string | null
  last_name?: string | null
}): string {
  const full = (p.full_name ?? '').trim()
  if (full) return full
  return [p.first_name, p.last_name].filter(Boolean).join(' ')
}
