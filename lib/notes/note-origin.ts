/**
 * Note origin links — PURE helpers, safe for client components.
 *
 * Every note stores the in-app path it was created from (`origin_url`) so the note can take
 * you back to the exact email / chat / client page weeks later. These helpers validate that
 * path (write-time AND render-time) and turn it into a human label for the "from" link.
 *
 * Deliberately free of any server import (no supabase) — client components render these.
 */

/**
 * Validate an in-app origin path. Must be a same-origin absolute path and NOT a protocol-relative
 * or backslash-smuggled off-site URL. Fixes the `/\evil.com` bypass in the dev-tracker helper
 * (browsers normalise `\`→`/`, so `startsWith('/') && !startsWith('//')` alone lets it through).
 */
export function safeOriginPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const s = raw.trim()
  if (!s.startsWith("/")) return null // must be a relative in-app path
  if (s.startsWith("//") || s.startsWith("/\\")) return null // protocol-relative / backslash smuggle
  if (s.includes("\\")) return null // no backslashes at all — browsers fold them to '/'
  if (/[\x00-\x1f]/.test(s)) return null // no control chars
  if (s.length > 512) return null
  return s
}

/**
 * Split text into plain and link segments so pasted URLs render as clickable
 * anchors WITHOUT any HTML injection — callers map segments to React elements.
 * Strictly http(s) (a `javascript:` scheme can never match), and trailing
 * sentence punctuation stays outside the link ("see https://x.com." → link
 * ends before the dot).
 */
export type TextSegment = { type: "text" | "link"; value: string }

export function splitLinkSegments(text: string): TextSegment[] {
  const out: TextSegment[] = []
  const re = /https?:\/\/[^\s]+/g
  let last = 0
  let m: RegExpExecArray | null
  // exec loop (not matchAll) — the TS build target can't iterate matchAll's iterator
  while ((m = re.exec(text)) !== null) {
    let url = m[0]
    // peel trailing punctuation that belongs to the sentence, not the URL
    while (/[.,;:!?)\]]$/.test(url)) url = url.slice(0, -1)
    if (!url) continue
    const start = m.index
    if (start > last) out.push({ type: "text", value: text.slice(last, start) })
    out.push({ type: "link", value: url })
    last = start + url.length
    re.lastIndex = last // continue right after the peeled URL, not the raw match
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) })
  return out
}

/**
 * A short human label for where a note came from — "Inbox", "Portal chats", the client page…
 * Falls back to a cleaned-up first path segment so a new page never renders as raw slug soup.
 */
export function describeOrigin(path: string): string {
  const p = path.split("?")[0].split("#")[0]
  const KNOWN: Array<[prefix: string, label: string]> = [
    ["/inbox", "Inbox"],
    ["/portal-chats", "Portal chats"],
    ["/team-chat", "Team chat"],
    ["/accounts/", "Client page"],
    ["/contacts/", "Contact page"],
    ["/leads", "Leads"],
    ["/finance", "Finance"],
    ["/tasks", "Tasks"],
    ["/calendar", "Calendar"],
    ["/notes", "Notes"],
    ["/tools/fax", "Fax"],
    ["/dev-board", "Dev board"],
  ]
  for (const [prefix, label] of KNOWN) {
    if (p === prefix || p === prefix.replace(/\/$/, "") || p.startsWith(prefix)) return label
  }
  const seg = p.split("/").filter(Boolean)[0]
  if (!seg) return "Dashboard"
  const words = seg.replace(/[-_]+/g, " ").trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Dashboard"
}
