/**
 * Bank Feed Matcher — Auto-reconciliation engine
 *
 * Matches incoming bank transactions (td_bank_feeds) against:
 * 1. CRM invoices (payments where invoice_status NOT IN ('Paid', 'Voided', 'Cancelled'))
 * 2. Pending activations (pending_activations where status = 'awaiting_payment')
 *
 * Match logic:
 * - Exact: amount matches within $1 / €1
 * - High: amount within 5% tolerance + sender name contains account/client name
 * - Medium: amount within 5% tolerance only
 *
 * When matched → marks invoice as Paid, triggers QB sync, updates bank feed status.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { syncPaymentToQB } from "@/lib/qb-sync"
import { runActivation } from "@/lib/operations/activate-service"
import { getAppSetting } from "@/lib/settings"
import { isMatchableInvoice, isTerminalInvoice, isPaidInvoice } from "@/lib/finance/invoice-matchability"
import { applyMoneyToInvoice, confirmedApplicationIsBackedByMoney } from "@/lib/finance/apply-payment"
import { resolveInvoiceStatusAfterPayment } from "@/lib/finance/invoice-money"
import {
  extractStripePaymentIntent,
  extractFeedEmails,
  extractInvoiceReference,
  bestNameEvidence,
  evaluateNameEvidence,
} from "@/lib/finance/feed-signals"
import { isChargeRefundedNow } from "@/lib/stripe-sync"
import { updateFeed } from "@/lib/finance/feed-write"
import {
  auditLinkMetadata,
  contestedMetadata,
  readRejectedPairs,
  type ContestedCandidate,
} from "@/lib/finance/feed-vocabulary"
import {
  selectBestCandidate,
  type ScoredCandidate,
} from "@/lib/finance/candidate-selection"

// Re-exported: the money math moved to lib/finance/invoice-money.ts so the single
// money writer (lib/finance/apply-payment.ts) can use it without a circular import.
export { resolveInvoiceStatusAfterPayment }

/*
 * REMOVED 2026-07-29 — the local STOP_WORDS list and the "any one word matched" name test.
 *
 * A hand-maintained blocklist was the ONLY thing standing between two unrelated clients and
 * each other's money, and it was missing "marketing" — which is how a $1,000 wire from LC
 * Marketing Consulting settled Aces Marketing Solutions' invoice on 2026-07-22. The rule now
 * lives in ONE place, `lib/finance/feed-signals.ts`, and requires the matched words to COVER a
 * minimum share of the client's name; the Finance review picker calls the same function, so the
 * screen a human is sent to can no longer rank names by a looser rule than the server used.
 */

/** Map the tied candidates onto the record a human reads in the review queue. */
function toContestedCandidates(tied: ScoredCandidate[]): ContestedCandidate[] {
  return tied.map((t) => ({
    payment_id: t.id,
    invoice_number: t.invoiceNumber,
    client_name: t.clientName ?? null,
    score: t.score,
    confidence: t.confidence,
  }))
}

interface MatchResult {
  matched: boolean
  paymentId?: string
  invoiceNumber?: string
  confidence?: string
  error?: string
  /**
   * Whether MONEY was actually applied. A feed can be legitimately `matched` to an
   * invoice with `moneyApplied: false` — the audit-link case (the invoice was
   * already Paid through another channel, e.g. the Stripe webhook closed it). The
   * old code reported success in that case while writing nothing, which is how a
   * genuine payment could look settled without ever crediting an invoice.
   */
  moneyApplied?: boolean
  /** Human-readable explanation when the feed was linked but no money moved. */
  note?: string
}

/**
 * Extract the numeric part of an invoice number for flexible matching.
 * INV-001312 → "1312", INV-001312 → "001312"
 */
function extractInvNumber(invoiceNum: string): { full: string; bare: number } | null {
  const match = invoiceNum.match(/inv[- ]?0*(\d+)/i)
  if (!match) return null
  return { full: invoiceNum.toLowerCase(), bare: parseInt(match[1], 10) }
}

/**
 * Check if feed text contains a reference to this invoice number,
 * handling common variations: INV-001312, inv1312, inv 1312, 001312, #INV-001312
 */
function invoiceRefInText(feedText: string, invoiceNum: string): boolean {
  if (!invoiceNum) return false
  const lower = invoiceNum.toLowerCase()

  // Direct match (exact or without dash)
  if (feedText.includes(lower)) return true
  if (feedText.includes(lower.replace("inv-", "inv "))) return true
  if (feedText.includes(lower.replace("inv-", "inv"))) return true

  // Extract numeric part for flexible matching
  const parsed = extractInvNumber(invoiceNum)
  if (!parsed) return false

  // Match "inv" + bare number (inv1312, inv 1312)
  const bareStr = String(parsed.bare)
  const invBarePattern = new RegExp(`inv[- ]?0*${bareStr}\\b`, 'i')
  if (invBarePattern.test(feedText)) return true

  // Match standalone 6-digit number with leading zeros (001312)
  const paddedStr = String(parsed.bare).padStart(6, '0')
  if (feedText.includes(paddedStr)) return true

  return false
}

/**
 * Try to match a td_bank_feeds record against open invoices.
 * If matched, marks both the feed and the invoice as paid.
 */
export async function matchAndReconcile(feedId: string): Promise<MatchResult> {
  try {
    // Fetch the bank feed record
    const { data: feed, error: fErr } = await supabaseAdmin
      .from("td_bank_feeds")
      .select("*")
      .eq("id", feedId)
      .single()

    if (fErr || !feed) return { matched: false, error: `Feed not found: ${fErr?.message}` }
    if (feed.status === "matched") return { matched: true, paymentId: feed.matched_payment_id }

    const feedAmount = Number(feed.amount)
    const feedCurrency = feed.currency || "USD"
    const senderLower = (feed.sender_name || "").toLowerCase()
    const memoLower = (feed.memo || "").toLowerCase()
    // The invoice reference may live on the column OR inside the Stripe payload
    // (charge metadata / expanded PaymentIntent metadata) — read both.
    const feedInvoiceRef = feed.sender_reference || extractInvoiceReference(feed)
    const refLower = (feedInvoiceRef || "").toLowerCase()

    const now = new Date().toISOString()
    const today = new Date().toISOString().split("T")[0]
    const paymentMethod = feed.source === "relay" ? "Wire (Relay)"
      : feed.source === "banking_circle" ? "Wire (Banking Circle)"
      : feed.source === "mercury" ? "Wire (Mercury)"
      : feed.source === "airwallex_api" || feed.source === "airwallex_email" ? "Wire (Airwallex)"
      : feed.source === "stripe" ? "Stripe"
      : "Wire"

    // Extract real sender from Wise transfers: "From <real_sender> Via WISE"
    let effectiveSender = senderLower
    const wiseMatch = (feed.memo || "").match(/from\s+(.+?)\s+via\s+wise/i)
    if (wiseMatch) {
      effectiveSender = wiseMatch[1].toLowerCase()
    }
    // Also check for Mercury format: "Merchant name: <company>"
    const merchantMatch = (feed.sender_name || "").match(/merchant name:\s*(?:\d+\/)?(.+)/i)
    if (merchantMatch && !wiseMatch) {
      effectiveSender = merchantMatch[1].toLowerCase().trim()
    }

    // Get all invoices — filter status AND currency in JS (PostgREST .in() on custom enums is unreliable).
    // `status` is selected alongside `invoice_status`: matchability reads BOTH columns
    // (see lib/finance/invoice-matchability.ts — reading invoice_status alone let 48
    // already-paid invoices with a NULL invoice_status stay live auto-match targets).
    // `is_test` is excluded so a QA fixture invoice can never absorb real client money.
    const { data: allInvoices, error: invQueryErr } = await supabaseAdmin
      .from("payments")
      .select("id, account_id, contact_id, invoice_number, invoice_status, status, is_test, total, amount, amount_due, amount_currency, stripe_payment_id, description, accounts:account_id(company_name), contacts:contact_id(full_name)")

    if (invQueryErr) {
      return { matched: false, error: `Invoice query failed: ${invQueryErr.message}` }
    }

    const realInvoices = (allInvoices || []).filter(inv => inv.is_test !== true)

    /**
     * IS THIS STRIPE MONEY STILL OURS? Called before EVERY settlement of a Stripe feed.
     *
     * The stored charge is a SNAPSHOT. A refund issued after we synced it leaves our
     * copy saying "received" forever, and the sync never revisits the row. So our record
     * can insist money is in the bank long after it went back to the client.
     *
     * This must gate EVERY tier, not just the payment-intent one. Now that the invoice
     * number travels with the payment, the dominant path is the invoice-reference tier,
     * which auto-settles — guarding only the payment-intent tier would plug the hole
     * that is about to become rare and leave open the one about to become common.
     *
     * When Stripe cannot be reached we DO NOT settle. This tier acts on the charge with
     * no corroborating evidence, so when the corroboration is unavailable the honest move
     * is to wait: the money is already in the bank, and a few hours' delay costs nothing.
     * Booking a refunded charge against a live invoice costs a client.
     *
     * Returns null when it is safe to proceed; otherwise the MatchResult to return.
     */
    // Records what the refund gate concluded, so the audit row can prove it ran.
    let lastRefundCheck: string | undefined

    const stripeMoneyStillOurs = async (candidatePaymentId: string): Promise<MatchResult | null> => {
      if (feed.source !== "stripe" || !feed.external_id) return null

      const check = await isChargeRefundedNow(String(feed.external_id))
      lastRefundCheck = check

      // Verified ours, or unverifiable-by-nature (no Stripe key / unknown charge id) —
      // proceed. "unchecked" carries the same exposure we had before the check existed;
      // stranding the feed forever would be worse.
      if (check === "ok" || check === "unchecked") return null

      if (check === "refunded") {
        await updateFeed(feedId, {
          status: "needs_review",
          matched_payment_id: candidatePaymentId,
          review_metadata: {
            refunded_or_disputed: true,
            candidate_payment_id: candidatePaymentId,
            checked_at: now,
          },
        }, "matcher:refunded-or-disputed")

        return {
          matched: false,
          paymentId: candidatePaymentId,
          moneyApplied: false,
          note: "This Stripe payment has been refunded or disputed — it was NOT applied to the invoice.",
        }
      }

      // "defer" — a transient Stripe failure. Leave the feed unmatched and retry on the
      // next run rather than settling money we cannot vouch for. The cash is already in
      // the bank; waiting costs nothing, booking a refund costs a client.
      //
      // The reason goes in `error`, not just a note: the orchestrator logs `error` on a
      // no-match, so without this a Stripe outage would look identical to "no candidate
      // found" in the cron log — a silent, indefinite halt of card reconciliation that
      // nobody would notice. A revoked or rotated Stripe key lands here.
      return {
        matched: false,
        moneyApplied: false,
        error: "Could not verify the payment with Stripe (deferred — will retry next run).",
        note: "Could not verify the payment with Stripe — deferred, will retry.",
      }
    }

    // ──────────────────────────────────────────────────────────────────────
    // TIER 0 — the CERTAIN link: Stripe PaymentIntent id.
    //
    // A Stripe charge carries the id of its PaymentIntent, and when our Stripe
    // webhook marks an invoice paid it stamps that SAME id on the invoice. Comparing
    // the two identifies the invoice with zero guessing — no amounts, no names, no
    // fuzzy matching. Nothing compared them before, which is why every card-paid
    // invoice left an orphaned, permanently-unmatched feed row behind (Tamás
    // Fazekas's €3,000).
    // ──────────────────────────────────────────────────────────────────────
    const paymentIntentId = extractStripePaymentIntent(feed)
    if (paymentIntentId) {
      const piMatches = realInvoices.filter(inv => inv.stripe_payment_id === paymentIntentId)

      if (piMatches.length > 0) {
        let target = piMatches[0]

        if (piMatches.length > 1) {
          // One PaymentIntent already maps to TWO payment rows in production (a real
          // invoice plus an orphan row created by an older webhook path). Prefer the
          // row that is a real invoice; if still ambiguous, REFUSE to guess.
          const withNumber = piMatches.filter(inv => !!inv.invoice_number)
          if (withNumber.length === 1) {
            target = withNumber[0]
          } else {
            await updateFeed(feedId, {
              status: "needs_review",
              review_metadata: {
                ambiguous_payment_intent: paymentIntentId,
                candidate_payment_ids: piMatches.map(inv => inv.id),
                candidate_invoice_numbers: piMatches.map(inv => inv.invoice_number),
                checked_at: now,
              },
            }, "matcher:ambiguous-payment-intent")

            return {
              matched: false,
              error: `This Stripe payment maps to ${piMatches.length} invoice records — a human must pick.`,
            }
          }
        }

        // Already closed (the webhook settled it, or a human marked it paid by hand).
        // Link it for the audit trail — but do NOT touch the money. This is the case
        // that previously had no home at all: the payment could never attach to its
        // own invoice, so it sat "unmatched" forever.
        if (isTerminalInvoice(target)) {
          // 'retroactive', NOT a new value. That string is load-bearing: the retroactive
          // pass builds its "this invoice is already audit-linked" set from it, and that
          // set is what stops a SECOND feed claiming the same invoice. A new confidence
          // value would be invisible to the guard. The certainty of THIS link (Stripe's
          // own payment-intent id) is recorded in review_metadata instead.
          await updateFeed(feedId, {
            matched_payment_id: target.id,
            match_confidence: "retroactive",
            matched_at: now,
            matched_by: "auto",
            status: "matched",
            review_metadata: auditLinkMetadata(
              "payment_intent",
              "Invoice was already paid through Stripe — linked for the audit trail; no money re-applied.",
            ),
          }, "matcher:tier0-audit-link")

          return {
            matched: true,
            paymentId: target.id,
            invoiceNumber: target.invoice_number ?? undefined,
            confidence: "certain_retroactive",
            moneyApplied: false,
            note: "Invoice was already paid through Stripe — linked for the audit trail; no money re-applied.",
          }
        }

        const piRefundGate = await stripeMoneyStillOurs(target.id)
        if (piRefundGate) return piRefundGate

        // Open invoice + certain identity → settle it.
        const piSettle = await settleInvoiceFromFeed(feedId, target.id, feedAmount, now, today, {
          paymentMethod,
          actor: "bank-feed:auto-payment-intent",
          runActivationChain: false,
          refundCheck: lastRefundCheck,
        })

        if (piSettle.applied) {
          await updateFeed(feedId, {
            matched_payment_id: target.id,
            match_confidence: piSettle.newStatus === "Partial" ? "partial" : "exact",
            matched_at: now,
            matched_by: "auto",
            status: "matched",
          }, "matcher:tier0-settled")

          return {
            matched: true,
            paymentId: target.id,
            invoiceNumber: target.invoice_number ?? undefined,
            confidence: piSettle.newStatus === "Partial" ? "partial" : "exact",
            moneyApplied: true,
          }
        }
        // Refused (already applied) → fall through to normal scoring rather than
        // claiming a match.
      }
    }

    // ──────────────────────────────────────────────────────────────────────
    // IDENTITY — who is this money from? Resolve by EMAIL, never by the name.
    //
    // On a card payment `sender_name` is the CARDHOLDER: "Bilaal Rajan" paying for
    // Simple Holdings USA, or the truncated "Fazek" for Tamás Fazekas. Matching on it
    // is worse than useless. The billing email, however, resolves cleanly to a CRM
    // contact and — through account_contacts — to the companies that contact belongs
    // to. When we know WHO paid, we only ever consider THEIR invoices.
    // ──────────────────────────────────────────────────────────────────────
    const feedEmails = extractFeedEmails(feed)
    const identityContactIds = new Set<string>()
    const identityAccountIds = new Set<string>()

    if (feedEmails.length > 0) {
      // CASE-INSENSITIVE, deliberately. Email addresses are case-insensitive by
      // standard, and CRM records are NOT reliably stored lowercase — the Stripe
      // webhook already uses a case-insensitive lookup for exactly this reason.
      // An exact-match lookup here would silently resolve NO identity for any client
      // whose email carries a capital letter, and the failure is indistinguishable
      // from "this payer isn't in the CRM" — the whole identity engine would quietly
      // do nothing for a chunk of the client base.
      const emailFilter = feedEmails
        .filter(e => !e.includes(",")) // a comma would break PostgREST's or() syntax
        .map(e => `email.ilike.${e}`)
        .join(",")

      if (emailFilter) {
        const { data: emailContacts } = await supabaseAdmin
          .from("contacts")
          .select("id")
          .or(emailFilter)

        for (const c of emailContacts ?? []) identityContactIds.add(c.id)
      }

      if (identityContactIds.size > 0) {
        const { data: idLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id")
          .in("contact_id", Array.from(identityContactIds))
        for (const l of idLinks ?? []) {
          if (l.account_id) identityAccountIds.add(l.account_id)
        }
      }
    }

    const identityResolved = identityContactIds.size > 0 || identityAccountIds.size > 0
    const belongsToPayer = (inv: { account_id: string | null; contact_id: string | null }) =>
      (inv.account_id != null && identityAccountIds.has(inv.account_id)) ||
      (inv.contact_id != null && identityContactIds.has(inv.contact_id))

    // Build contact → linked-company-names map. Handles the cross-entity payment case:
    // an ITIN invoice is linked to a contact (not an account), but the wire arrives from
    // the contact's LLC bank account (e.g. Valerio's ITIN paid from Closify Consulting LLC).
    // Without this map, the matcher only checks `accounts.company_name` (null for ITIN)
    // and `contacts.full_name` ("Valerio Di Santo") — neither matches "CLOSIFY CONSULTING"
    // in the sender name. Also covers the inverse: company invoice paid by a member's
    // personal account (matched via contact_id → other companies they're a member of).
    const contactIdsInScope = Array.from(
      new Set(realInvoices.map(i => i.contact_id).filter((id): id is string => !!id))
    )
    const contactToLinkedCompanies: Record<string, string[]> = {}
    if (contactIdsInScope.length > 0) {
      const { data: links } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id, accounts:account_id(company_name)")
        .in("contact_id", contactIdsInScope)
      for (const link of (links ?? [])) {
        const company = ((link.accounts as unknown as { company_name?: string } | null)?.company_name || "").trim()
        if (!company || !link.contact_id) continue
        if (!contactToLinkedCompanies[link.contact_id]) contactToLinkedCompanies[link.contact_id] = []
        contactToLinkedCompanies[link.contact_id].push(company)
      }
    }

    // Filter BOTH status and currency in code — PostgREST .eq()/.in() on custom enums returns wrong results.
    // Matchability is the SHARED predicate (lib/finance/invoice-matchability.ts): terminal if
    // EITHER status column says the invoice is closed, with a NULL invoice_status falling back to
    // `status`. Draft + Partial stay matchable (a Draft is a real obligation created at contract
    // signing; a Partial still owes its balance).
    const openInCurrency = realInvoices.filter(inv =>
      isMatchableInvoice(inv) && String(inv.amount_currency) === feedCurrency
    )

    // When we KNOW who paid, only that payer's invoices are candidates.
    //
    // This is the guard against the worst failure mode in the old matcher: an
    // amount-only ("medium") match would pin a stranger's invoice as the suggested
    // candidate — a $50 card payment from Simple Holdings' cardholder was one click
    // away from settling a $51 invoice belonging to an unrelated company. Scoping to
    // the payer makes that impossible.
    //
    // Deliberately conservative: if the payer is identified but none of THEIR invoices
    // fit, we do NOT fall back to everyone else's. The feed stays for a human. Losing
    // an automatic match is cheap; crediting the wrong client's invoice is not.
    const currencyFiltered = identityResolved
      ? openInCurrency.filter(belongsToPayer)
      : openInCurrency

    if (currencyFiltered.length === 0) {
      // No open invoice for this payer (or none at all). The retroactive pass below
      // may still link this to an already-paid invoice for the audit trail.
      if (!identityResolved) return { matched: false }
    }

    // Score each invoice. The shape is the shared `ScoredCandidate` so the pure, unit-tested
    // ambiguity guard consumes it directly — a local look-alike type would let the two drift.
    const candidates: ScoredCandidate[] = []
    const feedText = `${memoLower} ${refLower} ${effectiveSender} ${senderLower}`

    for (const inv of currencyFiltered) {
      // For Partial invoices, match against remaining balance (amount_due)
      const invAmount = inv.invoice_status === 'Partial'
        ? Number(inv.amount_due ?? inv.total ?? 0)
        : Number(inv.total ?? inv.amount ?? 0)
      const amountDiff = Math.abs(feedAmount - invAmount)
      const tolerance = invAmount * 0.05

      const directCompanyName = ((inv.accounts as unknown as { company_name: string })?.company_name || "").toLowerCase()
      const invoiceNum = (inv.invoice_number || "").toLowerCase()

      // The invoice REFERENCE beats the amount. Compute it BEFORE the amount filter.
      //
      // The amount check used to run first, so an invoice was thrown away for a price
      // mismatch even when the payment literally carried its invoice number. That made
      // the whole point of putting the number on the payment useless the moment the
      // figures didn't line up — a part-payment, a card surcharge, a rounding
      // difference. The reference is the strongest signal we have; it must not be
      // discarded by the weakest one.
      const invoiceRefMatch = invoiceRefInText(feedText, invoiceNum)

      // Skip only when the amount is way off AND the payment doesn't name this invoice.
      if (!invoiceRefMatch && amountDiff > tolerance && amountDiff > 1) continue

      // Build the full pool of company names to test against the feed:
      // the invoice's directly-linked account (if any) + every company the linked
      // contact is a member of (covers third-party payments — see contactToLinkedCompanies above).
      const linkedCompanyNames = (contactToLinkedCompanies[inv.contact_id || ""] || []).map(n => n.toLowerCase())
      const companyNamePool = Array.from(new Set([directCompanyName, ...linkedCompanyNames].filter(Boolean)))

      // ⛔ NAME EVIDENCE IS NOW A COVERAGE TEST, NOT "ANY ONE WORD MATCHED" (2026-07-29).
      // The old rule counted a name as matched when a SINGLE significant word appeared in the
      // payment text. On 2026-07-22 that word was "marketing" — shared by two unrelated
      // clients, identifying neither — and it auto-settled the wrong client's $1,000 invoice.
      // The rule lives in ONE place now (lib/finance/feed-signals.ts), shared with the Finance
      // review picker, so the screen a human is sent to cannot rank names by a looser rule
      // than the server used.
      const feedTexts = [effectiveSender, senderLower, memoLower, refLower]
      const companyEvidence = bestNameEvidence(companyNamePool, feedTexts)
      const nameMatch = companyEvidence.sufficient

      // Contact-first resolution: also match against contact full_name
      const contactName = ((inv.contacts as unknown as { full_name: string })?.full_name || "").toLowerCase()
      const contactEvidence = evaluateNameEvidence(contactName, feedTexts)
      const contactMatch = contactEvidence.sufficient
      // Something matched but not enough of the name: real evidence, too weak to settle on.
      const weakNameEvidence = !nameMatch && !contactMatch && (companyEvidence.weak || contactEvidence.weak)

      // Identity from the payer's email — the reliable signal on a card payment.
      // (The candidate pool is ALREADY scoped to the payer when identity resolved, so
      // this is true for every candidate here; it is kept explicit for scoring clarity
      // and so a future caller can't accidentally rely on the pool being scoped.)
      const identityMatch = identityResolved && belongsToPayer(inv)

      let confidence: "exact" | "high" | "medium"
      let score: number

      if (invoiceRefMatch && amountDiff <= tolerance) {
        // Invoice number found in memo/reference AND amount within 5% → strongest match
        confidence = "exact"
        score = 100
      } else if (invoiceRefMatch) {
        // The payment NAMES this invoice, but the figures don't line up — an
        // under-payment, an over-payment, or a fee taken off the top. This is a real
        // signal and must not be thrown away (the old code discarded it entirely), but
        // it must not auto-settle either: how much to apply is a judgement call.
        // "medium" routes it to a human with the right invoice already pinned.
        confidence = "medium"
        score = 60
      } else if (amountDiff < 1 && (nameMatch || contactMatch)) {
        // Exact amount (<$1 diff) AND company/contact name match → auto-match
        confidence = "exact"
        score = 95
      } else if (identityMatch && amountDiff < 1) {
        // Payer identified by email + exact amount, but no invoice reference.
        // "high", NOT "exact": with the default threshold this lands in the review
        // queue, correctly scoped to that client's invoices. It is deliberately not
        // auto-settled — a client with two same-priced invoices (Simple Holdings has
        // exactly that) is genuinely ambiguous, and only the invoice number can break
        // the tie. Once the number is carried on the payment (see stripe-checkout),
        // the "exact" tier above fires instead and no human is needed.
        confidence = "high"
        score = 75
      } else if ((nameMatch || contactMatch) && amountDiff <= tolerance) {
        // Company/contact name match + amount within 5% → high confidence
        confidence = "high"
        score = 70
      } else if (weakNameEvidence && amountDiff <= tolerance) {
        // PART of the name matched, but not enough of it to say who paid — e.g. a generic
        // industry word, or one word of a two-word name. Real evidence, so the invoice stays
        // a candidate and a human sees it; NEVER auto-settled, which is why this is 'medium'
        // and not 'high' (under the `exact_or_high` threshold setting, 'high' would settle).
        confidence = "medium"
        score = 55
      } else {
        // Amount-only match (no identity, no name, no invoice ref) → manual review only
        confidence = "medium"
        score = 50
      }

      // Boost for an invoice number in the reference — ONLY when the amount agrees.
      //
      // The reference match is generous by design: it will fire on any bare, zero-padded
      // six-digit number appearing anywhere in the memo or sender text. That is the
      // right trade-off when the amount corroborates it. It is the WRONG trade-off when
      // the amount does not: an incidental number in a memo would otherwise outrank a
      // properly corroborated candidate (identity + exact amount scores 75, name +
      // amount scores 70) and get pinned as THE suggestion in the review banner — one
      // click from settling a stranger's invoice. That is the exact shape this work
      // exists to eliminate.
      //
      // An uncorroborated reference hit still becomes a candidate (60) — it is real
      // evidence and must not be thrown away — it just does not outrank real proof.
      if (invoiceRefMatch && amountDiff <= tolerance) score += 20

      candidates.push({
        id: inv.id,
        invoiceNumber: inv.invoice_number,
        confidence,
        score,
        // Carried so the ambiguity guard can tell a duplicate-row tie (same client) from a
        // two-different-clients tie, and so the contested record names the client a human
        // would otherwise have to look up.
        accountId: inv.account_id,
        contactId: inv.contact_id,
        clientName:
          (inv.accounts as unknown as { company_name?: string } | null)?.company_name ??
          (inv.contacts as unknown as { full_name?: string } | null)?.full_name ??
          null,
      })
    }

    // ── Retroactive pass: check already-Paid invoices (audit trail only) ──
    // Run retroactive when: no candidates at all, OR only medium-confidence matches
    // (medium = amount-only, unreliable — retroactive with name/ref match is better)
    const bestOpenMatch = candidates.sort((a, b) => b.score - a.score)[0]
    const shouldTryRetroactive = candidates.length === 0 || (bestOpenMatch && bestOpenMatch.confidence === "medium")
    if (shouldTryRetroactive) {
      // Already-PAID invoices only (never Cancelled/Voided — audit-linking money to a
      // cancelled invoice would be a lie). Read BOTH columns: 48 production invoices are
      // status='Paid' with a NULL invoice_status, and checking invoice_status alone made
      // them invisible here while leaving them matchable above — exactly backwards.
      const paidAll = realInvoices.filter(inv =>
        (String(inv.invoice_status) === "Paid" || String(inv.status) === "Paid") &&
        String(inv.amount_currency) === feedCurrency
      )
      // Same identity scoping as the open-invoice pass: never audit-link a payment to
      // a stranger's paid invoice just because the amount happens to line up.
      const paidFiltered = identityResolved ? paidAll.filter(belongsToPayer) : paidAll

      if (paidFiltered.length > 0) {

        // ── The 1-invoice-many-feeds guard ───────────────────────────────────────
        //
        // "Is this invoice ALREADY claimed by some bank transaction?" — a membership test,
        // NOT a trust ranking. So it must not filter on match_confidence.
        //
        // It used to require `match_confidence = 'retroactive'`, which left a live hole:
        // an invoice SETTLED by a wire (confidence 'exact', money applied, invoice now
        // Paid) was NOT in the set — so a later, similar-amount feed could still
        // retroactively link itself to that same invoice. Two transactions, one invoice,
        // no warning.
        //
        // Keying on "matched, with an invoice attached" closes that, and it permanently
        // removes the failure class: no future confidence value can ever be invisible to
        // this guard. (Tier 0 does not consult this set — it links by Stripe's own
        // payment-intent id — so the broader guard only constrains the FUZZY pass, which
        // is exactly where guessing a second feed onto a claimed invoice is dangerous.)
        const { data: alreadyMatched, error: claimedErr } = await supabaseAdmin
          .from("td_bank_feeds")
          .select("matched_payment_id")
          .eq("status", "matched")
          .not("matched_payment_id", "is", null)

        if (claimedErr) {
          // Without this set we cannot tell whether an invoice is already claimed. Guessing
          // is how one invoice ends up attributed to two payments — refuse instead.
          console.error(`[bank-feed-matcher] Could not read claimed invoices; skipping the retroactive pass: ${claimedErr.message}`)
          return { matched: false, error: "Could not verify which invoices are already claimed — retroactive matching skipped." }
        }

        const retroMatchedIds = new Set((alreadyMatched ?? []).map(f => f.matched_payment_id))

        // ⛔ THIS PASS NEEDS THE SAME TWO GUARDS AS THE OPEN-INVOICE PASS ABOVE (2026-07-29).
        // It was missed by the first draft of this fix, which was worse than leaving it alone:
        // tightening the name rule upstream turns 'medium' into the COMMON outcome, and
        // `shouldTryRetroactive` fires precisely on 'medium' — so the incident feed would have
        // been routed straight into a pass that still used the old any-one-word name test and
        // still broke ties first-wins. The wire would have been audit-linked to the WRONG
        // client's already-paid invoice, marked `matched`, and dropped out of the review queue
        // with nobody credited. Same bug, quieter failure.
        const retroCandidates: ScoredCandidate[] = []

        for (const inv of paidFiltered) {
          // Skip if this invoice is already retroactively matched to another feed
          if (retroMatchedIds.has(inv.id)) continue

          const invAmount = Number(inv.total ?? inv.amount ?? 0)
          const amountDiff = Math.abs(feedAmount - invAmount)
          const tolerance = invAmount * 0.05

          if (amountDiff > tolerance && amountDiff > 1) continue

          const paidDirectCompany = ((inv.accounts as unknown as { company_name: string })?.company_name || "").toLowerCase()
          const paidInvNum = (inv.invoice_number || "").toLowerCase()

          // Same pool expansion as the primary pass: include contact's linked-account companies.
          // This is THE retroactive fix for ITIN-style invoices paid from the contact's LLC bank
          // account (e.g. Valerio's ITIN paid by Closify Consulting LLC wire).
          const paidLinkedCompanies = (contactToLinkedCompanies[inv.contact_id || ""] || []).map(n => n.toLowerCase())
          const paidCompanyPool = Array.from(new Set([paidDirectCompany, ...paidLinkedCompanies].filter(Boolean)))

          // Same shared coverage rule as the open pass — one implementation, no drift.
          const paidNameMatch = bestNameEvidence(paidCompanyPool, [feedText]).sufficient

          // Contact-first resolution for retroactive pass
          const paidContactName = ((inv.contacts as unknown as { full_name: string })?.full_name || "").toLowerCase()
          const paidContactMatch = evaluateNameEvidence(paidContactName, [feedText]).sufficient

          const paidInvRefMatch = invoiceRefInText(feedText, paidInvNum)

          // Identity (billing email → contact → their companies) is a STRONG signal —
          // stronger than the name, which on a card payment is the cardholder's.
          // Without this, Tamás Fazekas's €3,000 could never find its invoice: the
          // invoice had been marked paid BY HAND (so it carries no Stripe id for
          // Tier 0), and Stripe reported his name truncated to "Fazek", which matches
          // nothing. His email matched his contact record on the first try.
          const paidIdentityMatch = identityResolved && belongsToPayer(inv)

          // Require a strong signal: invoice reference, OR (identity/name + exact amount).
          if (
            !paidInvRefMatch &&
            !((paidNameMatch || paidContactMatch || paidIdentityMatch) && amountDiff < 1)
          ) continue

          const score = paidInvRefMatch ? 100 : paidIdentityMatch ? 90 : 80
          retroCandidates.push({
            id: inv.id,
            invoiceNumber: inv.invoice_number,
            confidence: "medium",
            score,
            accountId: inv.account_id,
            contactId: inv.contact_id,
            clientName:
              (inv.accounts as unknown as { company_name?: string } | null)?.company_name ??
              (inv.contacts as unknown as { full_name?: string } | null)?.full_name ??
              null,
          })
        }

        const retroSelection = selectBestCandidate(retroCandidates)

        if (retroSelection.contested) {
          // Two already-paid invoices are equally plausible homes for this transaction. An
          // audit link moves no money, but it is NOT harmless: it marks the feed `matched`,
          // removes it from the review queue, and permanently consumes that invoice's slot in
          // the 1-invoice-many-feeds guard — so the transaction that really belongs there can
          // never be linked. Park it instead.
          await updateFeed(feedId, {
            matched_payment_id: retroSelection.best?.id ?? null,
            match_confidence: "medium",
            status: "needs_review",
            review_metadata: contestedMetadata(
              toContestedCandidates(retroSelection.tied),
              new Date().toISOString(),
            ),
          }, "matcher:retroactive-contested")

          return {
            matched: false,
            paymentId: retroSelection.best?.id,
            invoiceNumber: retroSelection.best?.invoiceNumber ?? undefined,
            confidence: "medium",
          }
        }

        const bestRetro = retroSelection.best

        if (bestRetro) {
          // Link feed to the Paid invoice for audit trail — do NOT change invoice status
          await updateFeed(feedId, {
            matched_payment_id: bestRetro.id,
            match_confidence: "retroactive",
            matched_at: new Date().toISOString(),
            matched_by: "auto",
            status: "matched",
            review_metadata: auditLinkMetadata(
              "fuzzy",
              "Invoice was already paid — linked for the audit trail; no money applied.",
            ),
          }, "matcher:retroactive-audit-link")

          return {
            matched: true,
            paymentId: bestRetro.id,
            invoiceNumber: bestRetro.invoiceNumber ?? undefined,
            confidence: "retroactive",
            // The invoice was already paid through another channel. The feed is linked
            // for the audit trail and NO money is applied — callers must not report this
            // as a payment being reconciled.
            moneyApplied: false,
            note: "Invoice was already paid — linked for the audit trail; no money applied.",
          }
        }
      }

      // If we had no candidates at all (not even medium), return unmatched
      if (candidates.length === 0) {
        return { matched: false }
      }
      // Otherwise fall through to process the medium candidates below
    }


    // ⛔ A PAIR A HUMAN ALREADY REJECTED IS NOT A CANDIDATE (2026-07-29).
    // Un-matching returns this transaction to the unmatched pool and the bank sync re-runs
    // every 15 minutes. Without this, the matcher re-proposes — and can re-apply — the exact
    // pair someone just undid, so a corrected mis-match silently un-corrects itself within the
    // quarter hour. A human may still match a rejected pair BY HAND; only the machine is bound.
    const rejected = readRejectedPairs(feed?.review_metadata)
    const allowedCandidates =
      rejected.length === 0
        ? candidates
        : candidates.filter((c) => !rejected.some((r) => r.payment_id === c.id))

    if (allowedCandidates.length === 0) {
      // Everything that fit was already rejected by a person. Leave the transaction where a
      // human put it rather than proposing the same wrong answer again.
      return { matched: false }
    }

    // ⛔ NEVER SETTLE A TIE. This is the guard the 2026-07-22 incident needed: two candidates
    // shared the top score and `candidates.sort(...)[0]` handed $1,000 to whichever row the
    // database returned first. `selectBestCandidate` is pure and unit-tested, orders
    // deterministically, and reports a tie instead of resolving one.
    const selection = selectBestCandidate(allowedCandidates)
    const best = selection.best!

    if (selection.contested) {
      await updateFeed(feedId, {
        matched_payment_id: best.id,
        match_confidence: best.confidence,
        status: "needs_review",
        review_metadata: contestedMetadata(
          toContestedCandidates(selection.tied),
          new Date().toISOString(),
        ),
      }, "matcher:contested-candidates")

      return {
        matched: false,
        paymentId: best.id,
        invoiceNumber: best.invoiceNumber ?? undefined,
        confidence: best.confidence,
      }
    }

    // Threshold-gated auto-activation. Antonio's decision (2026-05-13):
    //   * 'exact' (default) — only `exact` confidence auto-marks the invoice
    //     Paid + triggers downstream activation. `high` lands in the review
    //     queue alongside `medium`.
    //   * 'exact_or_high'   — both `exact` and `high` auto-match. Only
    //     `medium` goes to review.
    // Anything pushed to review keeps the candidate (matched_payment_id +
    // match_confidence) for the reviewer; status='needs_review' surfaces it
    // in the sidebar badge and the /reconciliation review tab.
    const autoActivateThreshold = await getAppSetting<string>(
      "auto_activate_confidence_threshold",
      "exact",
    )
    const needsReview =
      best.confidence === "medium" ||
      (best.confidence === "high" && autoActivateThreshold === "exact")

    if (needsReview) {
      // Store as potential match but don't auto-reconcile.
      await updateFeed(feedId, {
        matched_payment_id: best.id,
        match_confidence: best.confidence,
        status: "needs_review",
      }, "matcher:below-auto-threshold")

      return { matched: false, paymentId: best.id, invoiceNumber: best.invoiceNumber ?? undefined, confidence: best.confidence }
    }

    // Same refund gate as the payment-intent tier. This is the path the invoice-
    // reference tier lands on — the one that becomes DOMINANT now that the number
    // travels with the payment — so it is the one that most needs the check.
    const autoRefundGate = await stripeMoneyStillOurs(best.id)
    if (autoRefundGate) return autoRefundGate

    // Apply the money through the ONE writer — same path the manual match uses.
    // It decides Paid vs Partial from the real balance (accumulating, capped), writes
    // the coherent tuple, mirrors to the client-visible tables, records the
    // (feed, invoice) application so the same money can never be credited twice, and
    // logs to action_log. The auto path previously used a SECOND algorithm
    // (`syncInvoiceStatus('payment', …)`) that OVERWROTE amount_paid — silently
    // erasing an earlier partial payment — and never wrote amount_due at all.
    //
    // Activation is left to `processBankFeedMatches`, which runs it after this
    // returns; running it here as well would activate the client twice.
    const settle = await settleInvoiceFromFeed(feedId, best.id, feedAmount, now, today, {
      paymentMethod,
      actor: "bank-feed:auto",
      runActivationChain: false,
      refundCheck: lastRefundCheck,
    })

    if (!settle.applied) {
      // The writer refused (already closed, or this exact transaction was already
      // applied). Do NOT mark the feed matched — that would report money as
      // reconciled when nothing moved. Park it for a human with the reason.
      await updateFeed(feedId, {
        matched_payment_id: best.id,
        match_confidence: best.confidence,
        status: "needs_review",
        review_metadata: {
          not_applied_reason: settle.reason ?? "unknown",
          not_applied_detail: settle.detail ?? null,
          checked_at: now,
        },
      }, "matcher:money-not-applied")

      return {
        matched: false,
        paymentId: best.id,
        invoiceNumber: best.invoiceNumber ?? undefined,
        confidence: best.confidence,
        moneyApplied: false,
        note: settle.detail,
      }
    }

    const settledPartial = settle.newStatus === "Partial"

    await updateFeed(feedId, {
      matched_payment_id: best.id,
      match_confidence: settledPartial ? "partial" : best.confidence,
      matched_at: now,
      matched_by: "auto",
      status: "matched",
    }, "matcher:auto-settled")

    if (settledPartial) {
      // Part-payment: the invoice keeps its remaining balance as debt. No installment
      // handler — the obligation is not settled yet.
      return {
        matched: true,
        paymentId: best.id,
        invoiceNumber: best.invoiceNumber ?? undefined,
        confidence: "partial",
        moneyApplied: true,
      }
    }

    // Fire the installment handler for installment 1/2 payments so the bundle's
    // service-delivery stages advance on real, bank-confirmed money-in. The
    // bank-feed match IS the real-payment signal (invoice Paid + matched feed) —
    // previously this only happened on manual mark-paid / the June cron, so
    // wire-paying clients got stranded. Guarded to Client accounts; classified
    // via payment_category (reliable) not the installment label; idempotent (the
    // handlers dedup their writes). A handler failure must never roll back the
    // match — swallow and log.
    try {
      const { data: paidPayment } = await supabaseAdmin
        .from("payments")
        .select("account_id, payment_category, status, invoice_status, year")
        .eq("id", best.id)
        .maybeSingle()

      if (paidPayment?.account_id) {
        const { isFirstInstallment, isSecondInstallment } = await import("@/lib/billing/payment-classification")
        const installmentNumber = isFirstInstallment(paidPayment) ? 1 : isSecondInstallment(paidPayment) ? 2 : null

        if (installmentNumber) {
          const { data: acct } = await supabaseAdmin
            .from("accounts")
            .select("account_type")
            .eq("id", paidPayment.account_id)
            .maybeSingle()

          if (acct?.account_type === "Client") {
            const installmentYear = paidPayment.year ?? new Date(today).getFullYear()
            const { onInstallmentPaid } = await import("@/lib/operations/payment")
            await onInstallmentPaid(paidPayment.account_id, installmentYear, installmentNumber)
          }
        }
      }
    } catch (handlerErr) {
      console.error(`[bank-feed-matcher] installment handler dispatch failed for payment ${best.id}:`, handlerErr)
    }

    // QB sync already fired inside the settler (QuickBooks is decommissioned — inert no-op).

    return {
      matched: true,
      moneyApplied: true,
      paymentId: best.id,
      invoiceNumber: best.invoiceNumber ?? undefined,
      confidence: best.confidence,
    }
  } catch (err) {
    return { matched: false, error: (err as Error).message }
  }
}

/*
 * REMOVED 2026-07-27 — `isStripePayoutFeed` / `markMercuryStripePayoutsOutgoing`.
 *
 * They decided what money was by READING THE BANK'S WORDING: a Mercury row whose memo
 * contained the literal "STRIPE; TRANSFER" was flipped to `outgoing` so the matcher would
 * skip it. Antonio rejected that approach outright — wording differs per bank and breaks the
 * day payouts move to a different account, and it had already missed every Relay payout
 * because those say "STRIPE - TRANSFER" with a dash, in a different field.
 *
 * Replaced by the invoice-first rule in `lib/finance/owner-ledger-projection.ts`: a deposit
 * stays in Finance only when something PROVES a client is paying an invoice, and everything
 * else — payouts included, whatever the bank calls them — goes to My Finances, where it is
 * visible and reversible with one click. No text matching anywhere in the decision.
 */

/** Outcome of settling one invoice from one bank transaction. */
type SettleResult = {
  invoiceNumber?: string
  /** False when nothing was credited (terminal invoice, already applied, zero). */
  applied: boolean
  reason?: string
  detail?: string
  newStatus?: "Paid" | "Partial"
}

/**
 * Settle ONE invoice from a bank feed: apply `appliedAmount` to it (Paid/Partial)
 * via the single money writer, then run the activation chain if the invoice is
 * linked to a pending_activation.
 *
 * Shared by `manualMatch` (applies the full feed amount to one invoice),
 * `manualMatchMulti` (applies each invoice's own waterfall allocation) AND — as of
 * 2026-07-14 — the AUTO matcher, which previously used a second, unsafe money
 * algorithm (`syncInvoiceStatus('payment', …)`) that overwrote `amount_paid`
 * instead of accumulating it and never wrote `amount_due`. One writer now.
 *
 * Does NOT touch the td_bank_feeds row — the caller owns the feed update.
 *
 * @returns whether money was actually applied, plus the invoice_number. A `false`
 *          with reason 'terminal' means the invoice is already closed: the caller
 *          may still LINK the feed for audit, but must not report a settlement.
 */
async function settleInvoiceFromFeed(
  feedId: string,
  paymentId: string,
  appliedAmount: number,
  now: string,
  today: string,
  opts: { paymentMethod?: string; actor?: string; runActivationChain?: boolean; refundCheck?: string } = {},
): Promise<SettleResult> {
  // ALL money now goes through the one writer. It owns: the terminal-invoice
  // refusal, the (feed, invoice) double-credit lock, the cap, the coherent
  // status/amount tuple, the client-visible mirrors, and the audit row.
  const result = await applyMoneyToInvoice({
    paymentId,
    appliedAmount,
    mode: "apply",
    paidDate: today,
    paymentMethod: opts.paymentMethod ?? "Wire (Manual Match)",
    actor: opts.actor ?? "bank-feed:staff",
    feedId,
    refundCheck: opts.refundCheck,
  })

  if (!result.applied) {
    // Nothing was credited. This is NOT a failure for a terminal invoice — linking
    // a feed to an already-Paid invoice is the legitimate audit-trail case (it is
    // how a Stripe payment gets tied to the invoice its own webhook already closed).
    // The caller records the link and reports honestly; it must never claim money
    // moved when it did not.
    return {
      invoiceNumber: result.invoiceNumber,
      applied: false,
      reason: result.reason,
      detail: result.detail,
    }
  }

  if (result.newStatus === "Paid") {
    syncPaymentToQB(paymentId, { paymentDate: today }).catch(() => {})
  }

  // The AUTO matcher passes runActivationChain: false — `processBankFeedMatches`
  // owns the activation chain for that path and runs it after matchAndReconcile
  // returns. Running it here too would fire the client's activation TWICE.
  // Manual matches have no orchestrator above them, so they keep running it.
  if (opts.runActivationChain === false) {
    return { invoiceNumber: result.invoiceNumber, applied: true, newStatus: result.newStatus }
  }

  // ⛔ A PART-PAYMENT NEVER ACTIVATES.
  //
  // The obligation is not met — the client still owes the balance — so the service
  // does not switch on, and the activation chain does not run. Activation follows the
  // payment that CLOSES the invoice.
  //
  // This guard is load-bearing, not hygiene. Without it: staff manually match a $500
  // wire to a $2,200 invoice → correctly recorded as part-paid, $1,700 still owed →
  // the activation chain runs anyway → activation settles the invoice IN FULL →
  // $1,700 that nobody ever paid is credited, the invoice reads Paid, and an audit row
  // is written swearing it was settled. The multi-invoice waterfall makes this the
  // NORMAL path, not an edge case: its last funded invoice is a Partial by design.
  //
  // The orchestrator applies the same rule on the auto path. Both are needed — this
  // one covers the manual paths, which have no orchestrator above them.
  if (result.newStatus === "Partial") {
    return { invoiceNumber: result.invoiceNumber, applied: true, newStatus: result.newStatus }
  }

  // Check if this invoice is linked to a pending_activation → trigger activation chain
  // Path A: direct link via portal_invoice_id (Stripe/Whop payment flow)
  const { data: pendingAct } = await supabaseAdmin
    .from("pending_activations")
    .select("id, status")
    .eq("portal_invoice_id", paymentId)
    .eq("status", "awaiting_payment")
    .maybeSingle()

  if (pendingAct) {
    await supabaseAdmin
      .from("pending_activations")
      .update({
        status: "payment_confirmed",
        payment_confirmed_at: now,
        updated_at: now,
      })
      .eq("id", pendingAct.id)

    // Trigger activate-service directly (no HTTP hop). Awaited so failures
    // are logged; the caller still gets `matched: true` because the match
    // itself succeeded.
    try {
      const activateResult = await runActivation(pendingAct.id)
      if (!activateResult.ok) {
        console.error(`[settleInvoiceFromFeed] runActivation returned error for pending ${pendingAct.id}: ${activateResult.error}`)
      }
    } catch (err) {
      console.error(`[settleInvoiceFromFeed] runActivation threw for pending ${pendingAct.id}:`, err)
    }
  } else {
    // Path B: bank-feed-created invoices have no portal_invoice_id.
    // Look up by account_id → offer token → pending_activation.
    // Only backfills payment_confirmed_at — does NOT re-trigger activation.
    const { data: paymentFull } = await supabaseAdmin
      .from("payments")
      .select("account_id")
      .eq("id", paymentId)
      .single()

    if (paymentFull?.account_id) {
      const { data: offer } = await supabaseAdmin
        .from("offers")
        .select("token")
        .eq("account_id", paymentFull.account_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (offer?.token) {
        const { data: pendingActByAccount } = await supabaseAdmin
          .from("pending_activations")
          .select("id, status")
          .eq("offer_token", offer.token)
          .is("payment_confirmed_at", null)
          .in("status", ["awaiting_payment", "payment_confirmed", "activated"])
          .maybeSingle()

        if (pendingActByAccount) {
          // Use the bank feed's transaction_date as the payment timestamp
          const { data: feedRow } = await supabaseAdmin
            .from("td_bank_feeds")
            .select("transaction_date")
            .eq("id", feedId)
            .single()

          const txTimestamp = feedRow?.transaction_date
            ? new Date(feedRow.transaction_date).toISOString()
            : now

          await supabaseAdmin
            .from("pending_activations")
            .update({ payment_confirmed_at: txTimestamp, updated_at: now })
            .eq("id", pendingActByAccount.id)
        }
      }
    }
  }

  return { invoiceNumber: result.invoiceNumber, applied: true, newStatus: result.newStatus }
}

/**
 * Manual match — used from the reconciliation UI.
 * Links a bank feed to a specific payment and marks both as reconciled.
 * Applies the FULL feed amount to the one invoice (Paid or Partial).
 */
export async function manualMatch(feedId: string, paymentId: string): Promise<MatchResult> {
  try {
    const now = new Date().toISOString()
    const today = new Date().toISOString().split("T")[0]

    // Fetch feed amount — needed for partial-payment calculation
    const { data: feed } = await supabaseAdmin
      .from("td_bank_feeds")
      .select("amount, status, source, external_id")
      .eq("id", feedId)
      .single()

    // Guard: never re-apply an already-matched feed. `manualMatchMulti` had this
    // guard; the single-invoice path did NOT. It was masked only because the old
    // settler skipped invoices already flagged Paid — a guard that evaporates for
    // a PARTIAL invoice. With amount_paid now accumulating, a double-click here
    // would have credited the money twice.
    if (feed?.status === "matched") {
      return { matched: false, error: "This transaction is already matched." }
    }

    // The refund check must protect the HUMAN too, not just the robot.
    //
    // The automatic matcher refuses a refunded charge — but staff clicking "Confirm this
    // match" had no such guard, and the screen gives them no way to know: a refunded
    // charge parks in the review queue looking like any other candidate. One click and
    // they book money the client already has back. The machine was protected and the
    // person was not, which is exactly the wrong way round.
    let manualRefundCheck: string | undefined
    if (feed?.source === "stripe" && feed.external_id) {
      const check = await isChargeRefundedNow(String(feed.external_id))
      manualRefundCheck = check
      if (check === "refunded") {
        return {
          matched: false,
          error: "This Stripe payment has been REFUNDED or disputed — the money is no longer ours. It cannot be applied to an invoice.",
        }
      }
      if (check === "defer") {
        return {
          matched: false,
          error: "Could not verify this payment with Stripe right now — please try again in a few minutes.",
        }
      }
    }

    const feedAmount = Number(feed?.amount ?? 0)

    // Settle FIRST, then record the link — so a refusal (terminal invoice, already
    // applied) cannot leave the feed marked 'matched' against money that never moved.
    const settle = await settleInvoiceFromFeed(feedId, paymentId, feedAmount, now, today, {
      // Record that the refund gate ran for this staff-confirmed match too — the audit
      // row must be able to prove the check happened, not just that it existed.
      refundCheck: manualRefundCheck,
    })

    // An already-PAID invoice may be audit-linked: that is the legitimate case of a
    // Stripe charge tied to the invoice its own webhook already closed. Money moves
    // nowhere, and we say so.
    //
    // Anything else terminal — Cancelled, Voided, Credit — must be REJECTED LOUDLY.
    // Recording a cheerful "linked" against a cancelled invoice, with no money applied,
    // is the same silent-success failure this whole change exists to kill: staff see a
    // green tick and the money is still sitting there unbooked.
    // `already_applied` is NOT an error here — it is the missing half of the operation.
    //
    // The lock is keyed on (this transaction, this invoice). A confirmed row can only mean
    // THIS transaction has already paid THIS invoice — which happens when a previous
    // attempt applied the money and then failed to record the link. Treating that as a
    // failure would brick the pair permanently: the money sits on the invoice, every retry
    // is told "already applied", and no screen can ever attach them. That is the
    // bricked-behind-a-false-error trap we spent two rounds removing from the money writer,
    // reappearing one layer up. So: finish the job — write the link and report success.
    // ── ASK THE LEDGER, NOT A REASON CODE ────────────────────────────────────────────
    //
    // "Is this transaction's money already on this invoice?" has exactly one reliable
    // answer: a CONFIRMED row in payment_applications for this (transaction, invoice) pair.
    //
    // A reason code cannot answer it. `terminal` means the invoice is closed — but it cannot
    // distinguish "someone else closed it" from "THIS transaction closed it, and we then
    // failed to write the link". Those need opposite answers. Keying on the reason got the
    // ORDINARY case wrong: a manual match normally settles the invoice IN FULL, so a retry
    // after a failed link hits the terminal guard first, and the transaction would have been
    // recorded and rendered as "audit link · no money applied" while its money sat on that
    // very invoice. Staff would go looking for money that was already booked.
    //
    // ⛔ AND THE LEDGER MUST BE CORROBORATED BY THE INVOICE (2026-07-29). A confirmed row is
    // normally proof, but a reversal that removed the money and then failed to un-confirm the
    // row leaves the two disagreeing — and trusting the row alone would mark this transaction
    // matched and report SUCCESS to the operator while applying nothing, sending staff to look
    // for money that is not there. `confirmedApplicationIsBackedByMoney` checks the invoice's
    // own balance and reports the mismatch loudly instead of inheriting it.
    const alreadyOnThisInvoice = settle.applied
      ? false
      : await confirmedApplicationIsBackedByMoney(feedId, paymentId)

    const moneyIsApplied = settle.applied || alreadyOnThisInvoice

    if (!moneyIsApplied) {
      const { data: target } = await supabaseAdmin
        .from("payments")
        .select("invoice_status, status")
        .eq("id", paymentId)
        .maybeSingle()

      // No money from THIS transaction is on the invoice. An already-PAID invoice may still
      // be audit-linked — the legitimate case of a card charge tied to the invoice its own
      // webhook already closed. Anything else terminal (Cancelled, Voided, Credit) is
      // REJECTED LOUDLY: recording a cheerful "linked" against a cancelled invoice is the
      // silent-success failure this whole change exists to kill.
      const auditLinkable = settle.reason === "terminal" && target != null && isPaidInvoice(target)

      if (!auditLinkable) {
        return {
          matched: false,
          error: settle.detail || "Nothing was applied to this invoice.",
        }
      }
    }

    // Always 'manual' — the database permits no other value here, and a new one would be
    // invisible to the retroactive-pass guard. Whether money actually moved is recorded in
    // review_metadata (and, definitively, by the presence or absence of a confirmed row in
    // payment_applications — a far stronger source of truth than any string).
    const linkResult = await updateFeed(feedId, {
      matched_payment_id: paymentId,
      match_confidence: "manual",
      matched_at: now,
      matched_by: "staff",
      status: "matched",
      ...(moneyIsApplied
        ? {}
        : {
            review_metadata: auditLinkMetadata(
              "manual",
              settle.detail ?? "Invoice was already paid — linked for the audit trail; no money applied.",
            ),
          }),
    }, "manual-match:link")

    if (!linkResult.ok) {
      // The money may already be on the invoice (the ledger row records it, so it cannot be
      // applied twice) but the transaction did NOT get linked. Reporting success would be a
      // lie — and this is now RECOVERABLE: a retry re-enters via the `already_applied`
      // branch above, which finishes the job instead of refusing forever.
      return {
        matched: false,
        error: `The payment was processed but the transaction could not be marked as matched: ${linkResult.error}. Try again — the money will not be applied twice.`,
      }
    }

    return {
      matched: true,
      paymentId,
      invoiceNumber: settle.invoiceNumber,
      // ALWAYS 'manual'. The old code returned 'manual_audit_link' here — a value this
      // codebase's own vocabulary forbids and the database rejects. Nothing persists it
      // today, so it was not yet a live bug; it was a loaded gun of exactly the class this
      // work exists to destroy. Whether money moved travels in `moneyApplied`.
      confidence: "manual",
      moneyApplied: moneyIsApplied,
      note: moneyIsApplied ? undefined : settle.detail,
    }
  } catch (err) {
    return { matched: false, error: (err as Error).message }
  }
}

/**
 * Partition selected invoices into the ones a multi-match should APPLY vs SKIP.
 * Terminal statuses (already paid/closed) are skipped so a stale or duplicate
 * selection can never double-charge `amount_paid`. Pure — exported for tests.
 */
export function partitionInvoicesForMultiMatch<T extends { id: string; invoice_status: string | null; status?: string | null }>(
  invoices: T[],
): { applicable: T[]; skippedIds: string[] } {
  const applicable: T[] = []
  const skippedIds: string[] = []
  for (const inv of invoices) {
    // Shared predicate — reads BOTH status columns. The old local set read
    // invoice_status only, so an invoice that was Paid via `status` but had a NULL
    // invoice_status slipped through and got credited a second time.
    if (isTerminalInvoice(inv)) skippedIds.push(inv.id)
    else applicable.push(inv)
  }
  return { applicable, skippedIds }
}

type WaterfallAllocation = { payment_id: string; applied: number; balance: number; status: "Paid" | "Partial" }

/**
 * Plan how a single incoming wire is spread across selected invoices, IN THE
 * GIVEN ORDER (the staff's selection order). Each invoice receives
 * `min(remaining wire, its balance)`: fully Paid if the wire covers its balance,
 * Partial if the wire runs out mid-invoice. Once the wire is exhausted the rest
 * receive nothing (they stay open as debt and are simply absent from the result).
 * Total applied across allocations always equals `min(feedAmount, sum of balances)`
 * — no invoice is ever over-credited. Pure — exported for tests.
 *
 * `leftover` = wire remaining after every funded invoice is covered (0 in the
 * typical underpayment/debt case; positive only when the wire exceeds total owed).
 */
export function planWaterfallAllocation<T extends { id: string; total: number | null; amount_paid: number | null }>(
  feedAmount: number,
  invoicesInOrder: T[],
): { allocations: WaterfallAllocation[]; leftover: number } {
  const EPS = 0.005 // sub-cent floor so float dust doesn't fund a phantom allocation
  const round2 = (n: number) => Math.round(n * 100) / 100
  let remaining = Number(feedAmount) || 0
  const allocations: WaterfallAllocation[] = []
  for (const row of invoicesInOrder) {
    if (remaining <= EPS) break // wire exhausted — remaining invoices stay open as debt
    const balance = Math.max(Number(row.total ?? 0) - Number(row.amount_paid ?? 0), 0)
    if (balance <= EPS) continue // nothing owed — skip, don't burn wire
    const toApply = Math.min(remaining, balance)
    allocations.push({
      payment_id: row.id,
      applied: round2(toApply),
      balance: round2(balance),
      status: toApply >= balance - EPS ? "Paid" : "Partial",
    })
    remaining -= toApply
  }
  return { allocations, leftover: round2(Math.max(remaining, 0)) }
}

/**
 * Multi-invoice manual match — one incoming transaction that settles SEVERAL
 * invoices (e.g. a single wire paying invoices for two different companies the
 * same person owns: "Partner Alliance" paying for itself + "Morgan & Taylor").
 *
 * WATERFALL allocation: the wire amount is applied across the selected invoices
 * IN SELECTION ORDER. Each invoice receives `min(remaining wire, its balance)` —
 * fully Paid if the wire covers its balance, Partial if the wire runs out
 * mid-invoice (the unpaid remainder stays as `amount_due`, i.e. debt). Once the
 * wire is exhausted the remaining selected invoices receive nothing and stay
 * fully open (debt). Total applied = the wire amount exactly; no invoice is ever
 * over-credited. This is the "client owes $3,000 but pays $2,000 → record the
 * difference as debt" rule. The feed links to the first FUNDED invoice via
 * `matched_payment_id` (keeps every existing single-FK read valid) and records
 * the full funded set + per-invoice allocation in `review_metadata`.
 *
 * Guards: no-op if the feed is already matched; silently skips invoices already
 * in a terminal status (Paid/Voided/Cancelled/Credit) so a double-click or a
 * stale selection can't double-charge `amount_paid`. A single id falls through
 * to `manualMatch` unchanged.
 */
export async function manualMatchMulti(
  feedId: string,
  paymentIds: string[],
): Promise<MatchResult & { appliedPaymentIds?: string[]; skippedPaymentIds?: string[] }> {
  try {
    const ids = Array.from(new Set((paymentIds ?? []).filter(Boolean)))
    if (ids.length === 0) return { matched: false, error: "No invoices selected." }
    if (ids.length === 1) return manualMatch(feedId, ids[0])

    const now = new Date().toISOString()
    const today = new Date().toISOString().split("T")[0]

    // Guard: never re-apply an already-matched feed (would double amount_paid).
    const { data: feed } = await supabaseAdmin
      .from("td_bank_feeds")
      .select("status, review_metadata, amount")
      .eq("id", feedId)
      .single()
    if (feed?.status === "matched") {
      return { matched: false, error: "This transaction is already matched." }
    }
    const feedAmount = Number(feed?.amount ?? 0)

    // Fetch all selected invoices at once, then partition into applicable vs
    // terminal (already paid/closed) so a stale/duplicate selection can't double-pay.
    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("id, invoice_status, status, total, amount_paid")
      .in("id", ids)
    const rows = (payments ?? []) as Array<{ id: string; invoice_status: string | null; status: string | null; total: number | null; amount_paid: number | null }>
    const foundIds = new Set(rows.map((r) => r.id))
    const missing = ids.filter((id) => !foundIds.has(id))
    const { applicable, skippedIds } = partitionInvoicesForMultiMatch(rows)
    const skipped = [...missing, ...skippedIds]

    // Order the applicable invoices by the caller's selection order, then plan the
    // waterfall: the wire is spread top-to-bottom, each invoice gets min(remaining
    // wire, its balance). Pure + unit-tested so the money math is verifiable.
    const applicableById = new Map(applicable.map((r) => [r.id, r]))
    const orderedApplicable = ids.map((id) => applicableById.get(id)).filter((r): r is typeof applicable[number] => Boolean(r))
    const { allocations, leftover } = planWaterfallAllocation(feedAmount, orderedApplicable)

    if (allocations.length === 0) {
      return { matched: false, error: "Nothing to apply — selected invoices are already paid/closed or the transaction amount is zero." }
    }

    const applied: string[] = []
    const notApplied: Array<{ payment_id: string; reason?: string }> = []
    let firstInvoiceNumber: string | undefined
    for (const alloc of allocations) {
      const settle = await settleInvoiceFromFeed(feedId, alloc.payment_id, alloc.applied, now, today)
      if (!firstInvoiceNumber) firstInvoiceNumber = settle.invoiceNumber
      // Only count an invoice as funded if money actually moved. The double-credit
      // lock or a terminal status can legitimately refuse one row of the waterfall;
      // reporting it as applied would overstate what the client paid off.
      if (settle.applied) applied.push(alloc.payment_id)
      else notApplied.push({ payment_id: alloc.payment_id, reason: settle.reason })
    }

    if (applied.length === 0) {
      return {
        matched: false,
        error: "Nothing was applied — the selected invoices are already paid, closed, or this transaction was already applied to them.",
      }
    }

    // Link the feed: primary FK = first applied invoice (keeps existing single-read
    // code valid); full set recorded in review_metadata for the audit trail.
    const existingMeta =
      feed?.review_metadata && typeof feed.review_metadata === "object"
        ? (feed.review_metadata as Record<string, unknown>)
        : {}
    await updateFeed(feedId, {
        matched_payment_id: applied[0],
        match_confidence: "manual",
        matched_at: now,
        matched_by: "staff",
        status: "matched",
        review_metadata: {
          ...existingMeta,
          multi_match: true,
          matched_payment_ids: applied,
          multi_match_allocations: allocations,
          // Positive = wire left over after covering every funded invoice;
          // 0 when the wire was fully consumed (typical underpayment/debt case).
          multi_match_leftover: leftover,
          ...(skipped.length ? { multi_match_skipped: skipped } : {}),
          // Rows the settler REFUSED (terminal / already-applied). Recorded so the
          // allocation plan can never look like it funded more than it did.
          ...(notApplied.length ? { multi_match_not_applied: notApplied } : {}),
        },
    }, "manual-match-multi:link")

    return {
      matched: true,
      paymentId: applied[0],
      invoiceNumber: firstInvoiceNumber,
      confidence: "manual",
      appliedPaymentIds: applied,
      skippedPaymentIds: skipped,
    }
  } catch (err) {
    return { matched: false, error: (err as Error).message }
  }
}
