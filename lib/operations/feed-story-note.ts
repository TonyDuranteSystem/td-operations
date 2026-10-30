/**
 * Write a payment's investigation on the invoice(s) it was linked to — so the next person (or AI) who looks
 * at that payment, or that invoice, already has the story (Antonio, 2026-10-30).
 *
 * Rules, each there because a reviewer found the failure without it:
 *  - ONLY a result the investigator was reasonably sure of (`identified` / `likely`). `unclear` stays on the
 *    payment and is never written on an invoice.
 *  - ONLY on an invoice the story is about: one it suggested, one of the person/company it named, or an
 *    invoice this very flow just created for that payment. Linking the payment to some OTHER invoice does
 *    not copy a story about someone else onto it.
 *  - The note is INTERNAL (`payments.notes` is staff context; the portal PDF and the client expense mirror
 *    never read it). It is labelled AI-written and UNVERIFIED, and each source says whether the system found
 *    it or only the AI cited it.
 *  - Appended after whatever is already there, once per payment (marker), with a compare-and-swap so a note
 *    someone else just typed is never overwritten; one retry, then a plain failure.
 *  - Best effort: the caller's link/create NEVER fails because of this. It reports back so the screen can say
 *    what happened.
 *
 * Writes to `payments` must live in lib/operations/ (ESLint rule P2.4), so this is where it is.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { formatDetailAmount } from "@/lib/finance/contested-invoice-detail"
import {
  appendStoryNote,
  buildStoryNote,
  INVESTIGATION_VERDICTS,
  type InvestigationVerdict,
  type StoredInvestigation,
} from "@/lib/finance/feed-investigation"

export interface FeedStoryResult {
  /** True when the payment carries an investigation worth writing at all. */
  hadStory: boolean
  written: string[]
  /** Already carried this payment's story. */
  alreadyThere: string[]
  skipped: Array<{ paymentId: string; reason: string }>
  failed: Array<{ paymentId: string; error: string }>
}

const none = (): FeedStoryResult => ({ hadStory: false, written: [], alreadyThere: [], skipped: [], failed: [] })

const WRITABLE: readonly InvestigationVerdict[] = ["identified", "likely"]

interface FeedRow {
  id: string
  source: string | null
  transaction_date: string | null
  amount: number | string | null
  currency: string | null
  sender_name: string | null
  review_metadata: Record<string, unknown> | null
}

/** Is this story about this invoice? Pure, so the three ways in are tested without a database. */
export function storyIsAboutInvoice(
  story: Pick<StoredInvestigation, "who" | "suggested_invoice_ids">,
  invoice: { id: string; account_id: string | null; contact_id: string | null },
  createdByThisFlow: boolean,
): boolean {
  if (createdByThisFlow) return true
  if (story.suggested_invoice_ids.includes(invoice.id)) return true
  if (story.who?.account_id && invoice.account_id && story.who.account_id === invoice.account_id) return true
  if (story.who?.contact_id && invoice.contact_id && story.who.contact_id === invoice.contact_id) return true
  return false
}

/** Append `block` to an invoice's note once, never overwriting a concurrent edit. */
export async function appendStoryToInvoiceNote(
  paymentId: string,
  feedId: string,
  block: string,
): Promise<{ ok: true; appended: boolean } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: row, error } = await supabaseAdmin.from("payments").select("notes").eq("id", paymentId).maybeSingle()
    if (error) return { ok: false, error: error.message }
    if (!row) return { ok: false, error: "invoice not found" }
    const previous = (row as { notes: string | null }).notes
    const { notes, appended } = appendStoryNote(previous, block, feedId)
    if (!appended) return { ok: true, appended: false }

    // eslint-disable-next-line no-restricted-syntax -- lib/operations is the allowed home for a payments write (P2.4 rule 1)
    let update = supabaseAdmin.from("payments").update({ notes }).eq("id", paymentId)
    update = previous == null ? update.is("notes", null) : update.eq("notes", previous)
    const { data: updated, error: updateError } = await update.select("id")
    if (updateError) return { ok: false, error: updateError.message }
    if (updated && updated.length > 0) return { ok: true, appended: true }
    // Someone changed the note between our read and our write: read it again and try once more.
  }
  return { ok: false, error: "the note was edited while saving — try again" }
}

/**
 * After a payment has been linked to (or an invoice created for) `paymentIds`, write its investigation on
 * those invoices. `createdPaymentIds` are invoices THIS flow just made for the payment.
 */
export async function writeFeedStoryToInvoices(
  feedId: string,
  paymentIds: readonly string[],
  createdPaymentIds: readonly string[] = [],
): Promise<FeedStoryResult> {
  try {
    const { data: feedData } = await supabaseAdmin
      .from("td_bank_feeds")
      .select("id, source, transaction_date, amount, currency, sender_name, review_metadata")
      .eq("id", feedId)
      .maybeSingle()
    const feed = feedData as FeedRow | null
    const raw = feed?.review_metadata && typeof feed.review_metadata === "object" ? (feed.review_metadata as Record<string, unknown>).investigation : null
    if (!feed || !raw || typeof raw !== "object") return none()
    const story = raw as StoredInvestigation
    if (!(INVESTIGATION_VERDICTS as readonly string[]).includes(story.verdict)) return none()

    const result: FeedStoryResult = { hadStory: true, written: [], alreadyThere: [], skipped: [], failed: [] }
    if (!WRITABLE.includes(story.verdict)) {
      for (const id of paymentIds) result.skipped.push({ paymentId: id, reason: "The investigation was not sure enough to write on an invoice." })
      return result
    }

    const { data: invoices } = await supabaseAdmin.from("payments").select("id, account_id, contact_id").in("id", [...paymentIds])
    const byId = new Map(((invoices ?? []) as Array<{ id: string; account_id: string | null; contact_id: string | null }>).map((i) => [i.id, i]))

    const amount = feed.amount == null ? null : Number(feed.amount)
    const paymentLine = [
      formatDetailAmount(amount, feed.currency) ?? `${amount ?? "?"} ${feed.currency ?? ""}`.trim(),
      feed.source ?? "bank feed",
      feed.transaction_date ? String(feed.transaction_date).slice(0, 10) : "date unknown",
      `from ${feed.sender_name ?? "unknown"}`,
    ].join(" · ")
    const block = buildStoryNote({
      feedId,
      at: story.at,
      paymentLine,
      verdict: story.verdict,
      summary: story.summary,
      story: story.story,
      sources: story.sources,
    })

    for (const id of paymentIds) {
      const invoice = byId.get(id)
      if (!invoice) {
        result.skipped.push({ paymentId: id, reason: "Invoice not found." })
        continue
      }
      if (!storyIsAboutInvoice(story, invoice, createdPaymentIds.includes(id))) {
        result.skipped.push({ paymentId: id, reason: "The investigation is about a different invoice or client, so it was not written here." })
        continue
      }
      const written = await appendStoryToInvoiceNote(id, feedId, block)
      if (written.ok === false) result.failed.push({ paymentId: id, error: written.error })
      else if (written.appended) result.written.push(id)
      else result.alreadyThere.push(id)
    }
    return result
  } catch (err) {
    console.error("[feed-story-note] failed (the link itself is unaffected):", err instanceof Error ? err.message : err)
    return { hadStory: true, written: [], alreadyThere: [], skipped: [], failed: [{ paymentId: "", error: err instanceof Error ? err.message : String(err) }] }
  }
}

/** One plain sentence for the screen, or null when there is nothing to say. */
export function describeStoryResult(r: FeedStoryResult): string | null {
  if (!r.hadStory) return null
  if (r.written.length) return r.written.length === 1 ? "The investigation was saved on the invoice's note." : `The investigation was saved on ${r.written.length} invoice notes.`
  if (r.failed.length) return "The investigation could NOT be saved on the invoice note."
  if (r.skipped.length) return r.skipped[0].reason
  return null
}
