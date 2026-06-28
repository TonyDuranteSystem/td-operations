/**
 * Terminal envelope statuses — an envelope in any of these is FINISHED and can no
 * longer be signed, sent, or dispatched to a signer. Centralized so every
 * mutating path checks the SAME set (a missing `declined` here let a parallel
 * co-signer sign — and resurrect — a declined envelope; round-4 stress QA).
 *
 * NOTE: deliberately used by the MUTATING paths (submit / send / dispatch /
 * decline). The signer `fetch` route intentionally still returns a declined or
 * completed envelope so the signer page can render the "Declined"/"Signed"
 * screen — do not gate fetch on this.
 */
export const TERMINAL_ENVELOPE_STATUSES = ["voided", "expired", "completed", "declined"] as const

export function isTerminalEnvelopeStatus(status: string | null | undefined): boolean {
  return !!status && (TERMINAL_ENVELOPE_STATUSES as readonly string[]).includes(status)
}
