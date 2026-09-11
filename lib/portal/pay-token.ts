/**
 * Pay-token lifecycle helpers.
 *
 * A pay_token is a per-payment opaque URL-safe string used as the ONLY
 * way to identify an invoice from the public `/pay/<token>` redirect.
 * It's generated lazily the first time an invoice needs one (i.e., the
 * first no-portal / One-Time send), then reused for every subsequent
 * reminder or resend so the email link is stable.
 *
 * Schema:
 *   payments.pay_token TEXT (nullable)
 *   partial unique index on (pay_token) WHERE pay_token IS NOT NULL
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/database.types"
import { generatePayToken } from "@/lib/email/invoice-email"

/**
 * Read or generate+persist a pay_token for the given payment.
 *
 * - If the row already has a pay_token, return it (idempotent — every
 *   call for the same invoice returns the same URL).
 * - Otherwise, generate a fresh 32-byte token, write it to the row, and
 *   return the new value.
 *
 * Uses the partial unique index as a collision guard — if the extremely
 * unlikely case of a collision happens, the UPDATE fails and we retry.
 */
export async function ensurePayToken(
  paymentId: string,
  supabase: SupabaseClient<Database>,
): Promise<string> {
  // Fast path: the row already has a token.
  const { data: existing, error: readErr } = await supabase
    .from("payments")
    .select("pay_token")
    .eq("id", paymentId)
    .single()

  if (readErr) {
    throw new Error(`ensurePayToken: could not read payment ${paymentId}: ${readErr.message}`)
  }
  if (existing?.pay_token) return existing.pay_token

  // Generate + persist. Retry-on-collision bounded to 3 attempts; the
  // birthday-paradox risk on 32 bytes of entropy across the entire
  // payments table is astronomically low, but the partial unique index
  // is there as a safety net and so is this loop.
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = generatePayToken()
    // eslint-disable-next-line no-restricted-syntax -- pay_token write on payments, scoped lifecycle helper, no dev_task
    const { data: updated, error: updateErr } = await supabase
      .from("payments")
      .update({ pay_token: candidate })
      .eq("id", paymentId)
      .is("pay_token", null) // only set if still null — safe against races
      .select("pay_token")
      .maybeSingle()

    if (updateErr) {
      // Unique-constraint violation → collision. Try again.
      if (/duplicate key|unique constraint/i.test(updateErr.message)) continue
      throw new Error(`ensurePayToken: update failed for ${paymentId}: ${updateErr.message}`)
    }

    if (updated?.pay_token) return updated.pay_token

    // Another writer won the race; re-read and return their value.
    const { data: raced } = await supabase
      .from("payments")
      .select("pay_token")
      .eq("id", paymentId)
      .single()
    if (raced?.pay_token) return raced.pay_token
  }

  throw new Error(`ensurePayToken: exhausted retries for ${paymentId}`)
}

export type InvoiceAudience = "portal" | "no_portal"

/**
 * Resolve the email audience for a payment. Checks the account's
 * portal_tier — 'active', 'onboarding', and 'formation' all mean the
 * recipient has a working portal login and can pay via the portal.
 * 'lead' (no account yet) and null fall back to no_portal, which sends
 * a Pay-with-Card button + bank details inline.
 *
 * For contact-only payments (account_id null, contact_id set — the
 * ITIN / standalone flow), we look at contacts.portal_tier instead.
 */
const PORTAL_AUDIENCE_TIERS = new Set(["active", "onboarding", "formation"])

export async function resolveInvoiceAudience(
  opts: { account_id: string | null; contact_id: string | null },
  supabase: SupabaseClient<Database>,
): Promise<InvoiceAudience> {
  // Prefer account portal_tier when we have an account.
  if (opts.account_id) {
    const { data: acct, error } = await supabase
      .from("accounts")
      .select("portal_tier, account_type")
      .eq("id", opts.account_id)
      .single()
    // Fail SAFE toward "portal" (no bank details shown) on a genuine lookup
    // failure — we don't actually know this recipient isn't a portal client,
    // and the two possible wrong defaults are not symmetric: silently
    // showing a no-portal client a "log in to pay" message instead of bank
    // details is a recoverable annoyance; silently showing a portal client
    // real bank details is a live money/compliance leak. Previously this
    // discarded `error` entirely and fell through to "no_portal" — the
    // leaking side — on any read failure (dev job 96e56d06, QA follow-up).
    if (error) {
      console.error(`resolveInvoiceAudience: account lookup failed for ${opts.account_id}, failing safe to "portal": ${error.message}`)
      return "portal"
    }
    if (acct?.portal_tier && PORTAL_AUDIENCE_TIERS.has(acct.portal_tier)) return "portal"
    return "no_portal"
  }

  // Contact-only payments: check contact.portal_tier.
  if (opts.contact_id) {
    const { data: c, error } = await supabase
      .from("contacts")
      .select("portal_tier")
      .eq("id", opts.contact_id)
      .single()
    if (error) {
      console.error(`resolveInvoiceAudience: contact lookup failed for ${opts.contact_id}, failing safe to "portal": ${error.message}`)
      return "portal"
    }
    if (c?.portal_tier && PORTAL_AUDIENCE_TIERS.has(c.portal_tier)) return "portal"
    return "no_portal"
  }

  return "no_portal"
}

/**
 * Bank details must never reach a portal-audience recipient. This is the
 * single gate every already-resolved bankDetails value passes through
 * before reaching a PDF or email, so a future edit can't silently invert
 * or drop the check at just one of several call sites (dev job 96e56d06,
 * QA follow-up — the repeated inline ternary this replaces had zero direct
 * test coverage of its own).
 */
export function gateBankDetailsForAudience<T>(
  bankDetails: T,
  audience: InvoiceAudience,
): T | null {
  return audience === "no_portal" ? bankDetails : null
}

/**
 * Historical invoices created before this fix may carry a machine-generated
 * "Bank Transfer: ..." / "Card payment available upon request." paragraph
 * baked directly into their stored message (dev jobs 1834af40 / 96e56d06 —
 * every render site used to just echo payment.message verbatim, so a portal
 * client saw bank details anyway despite the invoice PDF/email otherwise
 * correctly hiding them). New invoices no longer generate this paragraph at
 * all, but old rows still have it — so portal-audience recipients get it
 * stripped here, at every display site, rather than trusting every future
 * render site to remember. No-portal audiences see the message unchanged;
 * bank details are their real payment path.
 *
 * The markers below are the exact, stable literal prefixes every known
 * generated-text source has always used — never legitimate staff-typed
 * prose — so finding the earliest one and cutting there reliably recovers
 * just the staff's own note.
 *
 * The first two markers are the old createUnifiedInvoiceDraft generator's
 * shape (dev jobs 1834af40 / 96e56d06). The third is a DIFFERENT, still-live generator
 * with its own wording — the annual-installment webhook and cron
 * (app/api/webhooks/agreement-signed/route.ts, app/api/cron/annual-
 * installments/route.ts) each hardcode a "\nPlease remit payment by wire
 * transfer[...]" sentence directly into the invoice message at creation
 * time, independently of createUnifiedInvoiceDraft. Confirmed live on a
 * real portal-tier account's installment invoice: the sentence survived
 * untouched and told the client to look "below" for bank details that this
 * fix correctly no longer shows — an actively misleading document, not
 * just an incomplete one (dev job 96e56d06, QA follow-up).
 */
const GENERATED_PAYMENT_TEXT_MARKERS = [
  "\n\nBank Transfer:",
  "\n\nCard payment available upon request.",
  "\nPlease remit payment by wire transfer",
]

export function sanitizeInvoiceMessage(
  message: string | null | undefined,
  audience: InvoiceAudience,
): string {
  if (!message) return ""
  if (audience === "no_portal") return message

  let cutIndex = message.length
  for (const marker of GENERATED_PAYMENT_TEXT_MARKERS) {
    const idx = message.indexOf(marker)
    if (idx !== -1 && idx < cutIndex) cutIndex = idx
  }
  return message.slice(0, cutIndex).trim()
}
