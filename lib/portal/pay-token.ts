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
    const { data: acct } = await supabase
      .from("accounts")
      .select("portal_tier, account_type")
      .eq("id", opts.account_id)
      .single()
    if (acct?.portal_tier && PORTAL_AUDIENCE_TIERS.has(acct.portal_tier)) return "portal"
    return "no_portal"
  }

  // Contact-only payments: check contact.portal_tier.
  if (opts.contact_id) {
    const { data: c } = await supabase
      .from("contacts")
      .select("portal_tier")
      .eq("id", opts.contact_id)
      .single()
    if (c?.portal_tier && PORTAL_AUDIENCE_TIERS.has(c.portal_tier)) return "portal"
    return "no_portal"
  }

  return "no_portal"
}
