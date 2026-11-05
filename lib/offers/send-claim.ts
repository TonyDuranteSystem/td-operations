/**
 * Stops one offer being emailed twice (offer builder Part 3, item B, dev job d2971d11).
 *
 * Send (publishOffer) reads the offer's status once at the start and only writes "sent" AFTER the email has gone out — on purpose
 * (an offer is never marked sent when the email failed). The gap in between is where two Sends that start at almost the same moment
 * (a double click, the CRM button and Claude's offer_send tool together) both saw "draft", both passed, and both emailed the
 * client. One real pair of emails 12 seconds apart is in the log (christian-cambareri-2026-v2, 2026-05-21).
 *
 * The fix is a claim, taken BEFORE the client's login is made or anything is sent: one UPDATE that writes the time into
 * offers.send_started_at, but only where the offer is still a draft AND no claim younger than SEND_CLAIM_MINUTES exists. The
 * database decides atomically, so of two simultaneous Sends exactly one gets a row back; the other stops and sends nothing.
 *
 * - A Send that fails BEFORE the email goes out gives the claim back (releaseOfferSend), so it can be tried again at once.
 * - Once the email is out the claim is never given back; markOfferSent clears it in the same write that flips the status. If that
 *   write fails the claim simply stays and blocks a repeat for SEND_CLAIM_MINUTES — the safe side of the two mistakes.
 * - A server that dies mid-send leaves a claim behind; after SEND_CLAIM_MINUTES it no longer counts.
 *
 * It does NOT make a Gmail call that timed out after Gmail accepted the message safe to retry — nothing on our side can know that.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export const SEND_CLAIM_MINUTES = 10

/** One plain shape (this repo's TypeScript does not narrow a union on `ok`). */
export interface SendClaim {
  ok: boolean
  /** The time we wrote — only when `ok`. */
  claimedAt: string | null
  /** When not `ok`: true = another Send owns (or already finished) this offer; false = the claim could not be written at all. */
  alreadySent: boolean
  /** When not `ok`: the reason in plain words. */
  message: string
}

const refused = (alreadySent: boolean, message: string): SendClaim => ({ ok: false, claimedAt: null, alreadySent, message })

export async function claimOfferSend(token: string, now: Date = new Date()): Promise<SendClaim> {
  const claimedAt = now.toISOString()
  const cutoff = new Date(now.getTime() - SEND_CLAIM_MINUTES * 60_000).toISOString()

  const { data, error } = await supabaseAdmin
    .from("offers")
    // eslint-disable-next-line no-restricted-syntax -- send_started_at postdates generated types (migration 20261105-1500)
    .update({ send_started_at: claimedAt } as never)
    .eq("token", token)
    .eq("status", "draft")
    .or(`send_started_at.is.null,send_started_at.lt.${cutoff}`)
    .select("token")
  if (error) {
    return refused(false, `Could not start the send (${error.message}) — nothing was sent. Try again.`)
  }
  if (data && data.length > 0) return { ok: true, claimedAt, alreadySent: false, message: "" }

  // No row came back: either the offer is no longer a draft, or another Send holds the claim. Say which.
  const { data: row, error: readErr } = await supabaseAdmin
    .from("offers")
    // eslint-disable-next-line no-restricted-syntax -- send_started_at postdates generated types (migration 20261105-1500)
    .select("status, send_started_at" as never)
    .eq("token", token)
    .maybeSingle()
  if (readErr) {
    return refused(false, `Could not start the send (${readErr.message}) — nothing was sent. Try again.`)
  }
  const state = row as unknown as { status?: string | null; send_started_at?: string | null } | null
  if (!state) return refused(false, `Offer not found: ${token}`)
  if (state.status !== "draft") {
    return refused(true, `Offer already published (status: ${state.status}).`)
  }
  return refused(
    true,
    `Another Send of this offer is already in progress (started ${state.send_started_at ?? "a moment ago"}) — nothing was sent twice. If it did not finish, it frees itself after ${SEND_CLAIM_MINUTES} minutes and you can try again.`,
  )
}

/** Gives back OUR claim (matched on the time we wrote, so a newer holder's claim is never cleared). Never throws. */
export async function releaseOfferSend(token: string, claimedAt: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from("offers")
      // eslint-disable-next-line no-restricted-syntax -- send_started_at postdates generated types (migration 20261105-1500)
      .update({ send_started_at: null } as never)
      .eq("token", token)
      // eslint-disable-next-line no-restricted-syntax -- send_started_at postdates generated types (migration 20261105-1500)
      .eq("send_started_at" as never, claimedAt as never)
    if (error) console.error(`[send-claim] could not release the claim on ${token}: ${error.message} (it frees itself after ${SEND_CLAIM_MINUTES} minutes)`)
  } catch (e) {
    console.error(`[send-claim] could not release the claim on ${token}:`, e)
  }
}
