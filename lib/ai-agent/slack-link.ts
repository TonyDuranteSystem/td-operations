/**
 * Slack permalink parsing (dev job a6c3d75b, Antonio 2026-07-18).
 *
 * Antonio pasted a Slack link and the worker replied: "I can't access external URLs
 * or Slack links directly — I don't have a browser or Slack API access." That was
 * TRUE and honestly said — but it is a capability gap no correction can teach, and
 * the ability to read a Slack message already existed in the codebase (the Slack
 * integration uses it for the 🧠 reaction). It simply was never given to the worker.
 *
 * NOTE web browsing does NOT solve this: a Slack permalink behind workspace auth
 * cannot be fetched by a general web tool. It needs the Slack API with the bot
 * token, which is exactly what the existing helpers do.
 *
 * This module is the pure parsing half — no I/O — so the ts arithmetic is properly
 * testable.
 */

export interface ParsedSlackLink {
  channelId: string
  /** Slack message timestamp, e.g. "1752859200.123456". */
  ts: string
  /** Present when the link points at a reply inside a thread. */
  threadTs?: string
}

/**
 * Turn a Slack permalink into the channel + timestamp the API needs.
 *
 * Permalinks look like:
 *   https://<workspace>.slack.com/archives/C09ABCD1234/p1752859200123456
 *   …/p1752859200123456?thread_ts=1752859100.000100&cid=C09ABCD1234
 *
 * The `p…` segment is the timestamp with the dot removed: the first 10 digits are
 * seconds, the remainder is the microsecond part. Returns null for anything that
 * isn't a recognisable permalink (never guesses).
 */
export function parseSlackPermalink(input: string): ParsedSlackLink | null {
  const raw = (input ?? "").trim()
  if (!raw) return null

  // Tolerate a bare link, a markdown link, or a link inside a sentence.
  const match = raw.match(/https?:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10,})/i)
  if (!match) return null

  const channelId = match[1]
  const digits = match[2]
  // Need at least seconds (10) + some fractional part to form a valid ts.
  if (digits.length <= 10) return null
  const ts = `${digits.slice(0, 10)}.${digits.slice(10)}`

  // A reply link carries the parent thread ts as a query param.
  const threadMatch = raw.match(/[?&]thread_ts=(\d{10}\.\d+)/)
  const threadTs = threadMatch ? threadMatch[1] : undefined

  return threadTs ? { channelId, ts, threadTs } : { channelId, ts }
}

/** True when the text contains something that looks like a Slack permalink. */
export function containsSlackLink(text: string): boolean {
  return parseSlackPermalink(text) !== null
}
