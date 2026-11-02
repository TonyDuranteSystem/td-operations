/**
 * The unique id a chat screen stamps on a message BEFORE it tries to send it (the "outbox": a message that cannot be delivered right away is kept on the
 * phone and sent again later). The server stores the message under that same id, so a send that worked but whose answer was lost, sent again, finds its own
 * row and answers with it instead of posting the message twice. No database change: it is the message's ordinary id.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The id the browser sent, or null when it sent none (an older screen) or sent something that is not a uuid. */
export function parseClientId(v: unknown): string | null {
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : null
}

/** A new id for a message about to be queued (the browser makes it; falls back to a random uuid-shaped one where `crypto.randomUUID` is missing). */
export function newClientId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
