/**
 * Which WhatsApp messages make the CRM play a notification sound (dev job c84dfb4d).
 *
 * Antonio 2026-10-07: "I should receive a sound for every new message". The receiver (app/api/wa-bridge/[channelId]/route.ts) puts
 * `{ inbound: N }` on the existing 'whatsapp' live-update signal for N such messages; the dashboard listener plays the tone.
 * Pure (no I/O) so it is unit-tested.
 *
 * A message counts only if it is (1) from the CUSTOMER (never our own reply or something typed on the phone), and (2) RECENT — a
 * history download, or a delayed delivery after the link was down for hours, must never make every open CRM beep.
 */

/** A customer message older than this when we save it is "history", not "new". */
export const FRESH_INBOUND_MAX_AGE_MS = 3 * 60_000

/** A little clock skew into the future is fine (the phone's clock vs ours); more than this is nonsense. */
const FUTURE_SKEW_MS = 5 * 60_000

export function isFreshInbound(direction: string, createdAtIso: string, now: Date): boolean {
  if (direction !== "inbound") return false
  const t = Date.parse(createdAtIso)
  if (!Number.isFinite(t)) return false
  const age = now.getTime() - t
  return age <= FRESH_INBOUND_MAX_AGE_MS && age >= -FUTURE_SKEW_MS
}

/** The payload for the 'whatsapp' signal: `{ inbound: n }` for n >= 1 new customer messages, otherwise none (the signal stays payload-free). */
export function inboundSignalPayload(freshInbound: number): { inbound: number } | undefined {
  return Number.isInteger(freshInbound) && freshInbound >= 1 ? { inbound: Math.min(freshInbound, 99) } : undefined
}
