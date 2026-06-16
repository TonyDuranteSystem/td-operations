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
import { syncInvoiceStatus } from "@/lib/portal/unified-invoice"
import { runActivation } from "@/lib/operations/activate-service"
import { getAppSetting } from "@/lib/settings"

// Common business words excluded from name matching to prevent false positives
const STOP_WORDS = new Set([
  // Legal suffixes
  "llc", "inc", "ltd", "corp", "co", "plc", "gmbh", "srl",
  // Generic business words (cause cross-company false matches)
  "consulting", "commerce", "international", "services", "holdings",
  "management", "solutions", "ventures", "capital", "partners",
  "trading", "digital", "global", "group", "media", "investments",
  "properties", "enterprises", "advisors", "associates", "agency",
  "solution", "strategies", "accelerator",
  // Common filler words
  "the", "and", "for", "via", "from", "tax", "return", "annual",
  "service", "fee", "payment", "invoice", "contractor", "vendor",
  "company", "first",
  // Payment processor names (appear in sender but aren't the actual client)
  "wise",
])

interface MatchResult {
  matched: boolean
  paymentId?: string
  invoiceNumber?: string
  confidence?: string
  error?: string
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
    const refLower = (feed.sender_reference || "").toLowerCase()

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

    // Get all invoices — filter status AND currency in JS (PostgREST .in() on custom enums is unreliable)
    const { data: allInvoices, error: invQueryErr } = await supabaseAdmin
      .from("payments")
      .select("id, account_id, contact_id, invoice_number, invoice_status, total, amount, amount_due, amount_currency, description, accounts:account_id(company_name), contacts:contact_id(full_name)")

    if (invQueryErr) {
      return { matched: false, error: `Invoice query failed: ${invQueryErr.message}` }
    }

    // Build contact → linked-company-names map. Handles the cross-entity payment case:
    // an ITIN invoice is linked to a contact (not an account), but the wire arrives from
    // the contact's LLC bank account (e.g. Valerio's ITIN paid from Closify Consulting LLC).
    // Without this map, the matcher only checks `accounts.company_name` (null for ITIN)
    // and `contacts.full_name` ("Valerio Di Santo") — neither matches "CLOSIFY CONSULTING"
    // in the sender name. Also covers the inverse: company invoice paid by a member's
    // personal account (matched via contact_id → other companies they're a member of).
    const contactIdsInScope = Array.from(
      new Set((allInvoices ?? []).map(i => i.contact_id).filter((id): id is string => !!id))
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
    // Use a blocklist of terminal statuses rather than an allowlist: any invoice that isn't
    // already Paid, Voided, or Cancelled represents money still expected and should be matchable
    // (includes Draft — created at contract signing, real obligation, payment can arrive before
    // the invoice is formally sent).
    const currencyFiltered = (allInvoices || []).filter(inv =>
      isMatchableInvoiceStatus(String(inv.invoice_status)) && String(inv.amount_currency) === feedCurrency
    )

    if (currencyFiltered.length === 0) {
      return { matched: false }
    }

    // Score each invoice
    type ScoredInvoice = {
      id: string
      invoiceNumber: string | null
      confidence: "exact" | "high" | "medium"
      score: number
    }

    const candidates: ScoredInvoice[] = []
    const feedText = `${memoLower} ${refLower} ${effectiveSender} ${senderLower}`

    for (const inv of currencyFiltered) {
      // For Partial invoices, match against remaining balance (amount_due)
      const invAmount = inv.invoice_status === 'Partial'
        ? Number(inv.amount_due ?? inv.total ?? 0)
        : Number(inv.total ?? inv.amount ?? 0)
      const amountDiff = Math.abs(feedAmount - invAmount)
      const tolerance = invAmount * 0.05

      // Skip if amount is way off
      if (amountDiff > tolerance && amountDiff > 1) continue

      const directCompanyName = ((inv.accounts as unknown as { company_name: string })?.company_name || "").toLowerCase()
      const invoiceNum = (inv.invoice_number || "").toLowerCase()

      // Build the full pool of company names to test against the feed:
      // the invoice's directly-linked account (if any) + every company the linked
      // contact is a member of (covers third-party payments — see contactToLinkedCompanies above).
      const linkedCompanyNames = (contactToLinkedCompanies[inv.contact_id || ""] || []).map(n => n.toLowerCase())
      const companyNamePool = Array.from(new Set([directCompanyName, ...linkedCompanyNames].filter(Boolean)))

      // Check if sender/memo/reference contains any of the candidate company names.
      // Use word boundary regex to avoid substring false matches (e.g. "solution" inside "solutions").
      const nameMatch = companyNamePool.some(cname => {
        const nameWords = cname.split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w))
        return nameWords.length > 0 && nameWords.some(w => {
          const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
          return re.test(effectiveSender) || re.test(senderLower) || re.test(memoLower) || re.test(refLower)
        })
      })

      // Contact-first resolution: also match against contact full_name
      const contactName = ((inv.contacts as unknown as { full_name: string })?.full_name || "").toLowerCase()
      const contactWords = contactName.split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w))
      const contactMatch = contactWords.length > 0 && contactWords.some(w => {
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
        return re.test(effectiveSender) || re.test(senderLower) || re.test(memoLower) || re.test(refLower)
      })

      // Check both exact invoice number AND flexible INV-NNNNNN pattern in feed text
      const invoiceRefMatch = invoiceRefInText(feedText, invoiceNum)

      let confidence: "exact" | "high" | "medium"
      let score: number

      if (invoiceRefMatch && amountDiff <= tolerance) {
        // Invoice number found in memo/reference AND amount within 5% → strongest match
        confidence = "exact"
        score = 100
      } else if (amountDiff < 1 && (nameMatch || contactMatch)) {
        // Exact amount (<$1 diff) AND company/contact name match → auto-match
        confidence = "exact"
        score = 95
      } else if ((nameMatch || contactMatch) && amountDiff <= tolerance) {
        // Company/contact name match + amount within 5% → high confidence
        confidence = "high"
        score = 70
      } else {
        // Amount-only match (no name, no invoice ref) → manual review only
        confidence = "medium"
        score = 50
      }

      // Boost for invoice number in reference
      if (invoiceRefMatch) score += 20

      candidates.push({
        id: inv.id,
        invoiceNumber: inv.invoice_number,
        confidence,
        score,
      })
    }

    // ── Retroactive pass: check already-Paid invoices (audit trail only) ──
    // Run retroactive when: no candidates at all, OR only medium-confidence matches
    // (medium = amount-only, unreliable — retroactive with name/ref match is better)
    const bestOpenMatch = candidates.sort((a, b) => b.score - a.score)[0]
    const shouldTryRetroactive = candidates.length === 0 || (bestOpenMatch && bestOpenMatch.confidence === "medium")
    if (shouldTryRetroactive) {
      // Reuse allInvoices from above, filter for Paid + correct currency in JS
      const paidFiltered = (allInvoices || []).filter(inv =>
        String(inv.invoice_status) === "Paid" && String(inv.amount_currency) === feedCurrency
      )

      if (paidFiltered.length > 0) {

        // Get already-retroactively-matched payment IDs to avoid 1-invoice-many-feeds
        const { data: alreadyMatched } = await supabaseAdmin
          .from("td_bank_feeds")
          .select("matched_payment_id")
          .eq("status", "matched")
          .eq("match_confidence", "retroactive")

        const retroMatchedIds = new Set((alreadyMatched ?? []).map(f => f.matched_payment_id))

        // Score retroactive candidates — pick the best, don't just take the first
        let bestRetro: { id: string; invoiceNumber: string | null; score: number } | null = null

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

          const paidNameMatch = paidCompanyPool.some(cname => {
            const paidNameWords = cname.split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w))
            return paidNameWords.length > 0 && paidNameWords.some(w => {
              const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
              return re.test(feedText)
            })
          })

          // Contact-first resolution for retroactive pass
          const paidContactName = ((inv.contacts as unknown as { full_name: string })?.full_name || "").toLowerCase()
          const paidContactWords = paidContactName.split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w))
          const paidContactMatch = paidContactWords.length > 0 && paidContactWords.some(w => {
            const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
            return re.test(feedText)
          })

          const paidInvRefMatch = invoiceRefInText(feedText, paidInvNum)

          // Require strong signal: invoice ref OR (name/contact match + exact amount)
          if (!paidInvRefMatch && !((paidNameMatch || paidContactMatch) && amountDiff < 1)) continue

          const score = paidInvRefMatch ? 100 : 80
          if (!bestRetro || score > bestRetro.score) {
            bestRetro = { id: inv.id, invoiceNumber: inv.invoice_number, score }
          }
        }

        if (bestRetro) {
          // Link feed to the Paid invoice for audit trail — do NOT change invoice status
          await supabaseAdmin
            .from("td_bank_feeds")
            .update({
              matched_payment_id: bestRetro.id,
              match_confidence: "retroactive",
              matched_at: new Date().toISOString(),
              matched_by: "auto",
              status: "matched",
              updated_at: new Date().toISOString(),
            })
            .eq("id", feedId)

          return {
            matched: true,
            paymentId: bestRetro.id,
            invoiceNumber: bestRetro.invoiceNumber ?? undefined,
            confidence: "retroactive",
          }
        }
      }

      // If we had no candidates at all (not even medium), return unmatched
      if (candidates.length === 0) {
        return { matched: false }
      }
      // Otherwise fall through to process the medium candidates below
    }


    // Sort by score descending — take the best match
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]

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
      await supabaseAdmin
        .from("td_bank_feeds")
        .update({
          matched_payment_id: best.id,
          match_confidence: best.confidence,
          status: "needs_review",
          updated_at: new Date().toISOString(),
        })
        .eq("id", feedId)

      return { matched: false, paymentId: best.id, invoiceNumber: best.invoiceNumber ?? undefined, confidence: best.confidence }
    }

    // Auto-match: mark feed as matched
    const now = new Date().toISOString()
    const today = new Date().toISOString().split("T")[0]
    const paymentMethod = feed.source === "relay" ? "Wire (Relay)"
      : feed.source === "banking_circle" ? "Wire (Banking Circle)"
      : feed.source === "mercury" ? "Wire (Mercury)"
      : feed.source === "airwallex_api" || feed.source === "airwallex_email" ? "Wire (Airwallex)"
      : feed.source === "stripe" ? "Stripe"
      : "Wire"

    // Check if this is a partial payment (feed amount < invoice remaining balance)
    const bestInvoice = currencyFiltered.find(inv => inv.id === best.id)
    const bestInvoiceBalance = bestInvoice?.invoice_status === 'Partial'
      ? Number(bestInvoice?.amount_due ?? bestInvoice?.total ?? 0)
      : Number(bestInvoice?.total ?? bestInvoice?.amount ?? 0)
    const bestInvoiceTotal = Number(bestInvoice?.total ?? bestInvoice?.amount ?? 0)
    const isPartialPayment = feedAmount < bestInvoiceBalance && feedAmount >= bestInvoiceTotal * 0.2 && Math.abs(feedAmount - bestInvoiceBalance) >= 1

    if (isPartialPayment) {
      // Partial payment — mark as Partial, not Paid
      await supabaseAdmin
        .from("td_bank_feeds")
        .update({
          matched_payment_id: best.id,
          match_confidence: "partial",
          matched_at: now,
          matched_by: "auto",
          status: "matched",
          updated_at: now,
        })
        .eq("id", feedId)

      await syncInvoiceStatus("payment", best.id, "Partial", today, feedAmount)

      // eslint-disable-next-line no-restricted-syntax
      await supabaseAdmin
        .from("payments")
        .update({ payment_method: paymentMethod })
        .eq("id", best.id)

      return {
        matched: true,
        paymentId: best.id,
        invoiceNumber: best.invoiceNumber ?? undefined,
        confidence: "partial",
      }
    }

    // Full payment — mark as Paid
    await supabaseAdmin
      .from("td_bank_feeds")
      .update({
        matched_payment_id: best.id,
        match_confidence: best.confidence,
        matched_at: now,
        matched_by: "auto",
        status: "matched",
        updated_at: now,
      })
      .eq("id", feedId)

    // Mark invoice as Paid via unified system (updates BOTH payments + client_invoices)
    await syncInvoiceStatus("payment", best.id, "Paid", today, feedAmount)

    // Also set payment_method on the payments record
    // eslint-disable-next-line no-restricted-syntax
    await supabaseAdmin
      .from("payments")
      .update({ payment_method: paymentMethod })
      .eq("id", best.id)

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

    // QB sync (non-blocking)
    syncPaymentToQB(best.id, { paymentDate: today }).catch(() => {})

    return {
      matched: true,
      paymentId: best.id,
      invoiceNumber: best.invoiceNumber ?? undefined,
      confidence: best.confidence,
    }
  } catch (err) {
    return { matched: false, error: (err as Error).message }
  }
}

/**
 * Returns true if a td_bank_feeds row is a Stripe payout deposit on Mercury.
 * These rows are already tracked via the Stripe sync (source='stripe'); the Mercury
 * entry is a redundant deposit notification — not a client payment to reconcile.
 *
 * Exported for unit tests.
 */
export function isStripePayoutFeed(memo: string | null, senderReference: string | null): boolean {
  const memoUp = (memo || "").toUpperCase()
  const refUp = (senderReference || "").toUpperCase()
  return memoUp.includes("STRIPE; TRANSFER") || refUp.includes("STRIPE; TRANSFER")
}

/**
 * Marks unmatched Mercury/mercury_api rows that are Stripe payouts as 'outgoing'
 * so the matcher loop skips them. Called as a pre-processing step in check-wire-payments.
 */
export async function markMercuryStripePayoutsOutgoing(): Promise<{ marked: number }> {
  const { data: feeds, error } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, memo, sender_reference")
    .in("source", ["mercury", "mercury_api"])
    .eq("status", "unmatched")

  if (error || !feeds || feeds.length === 0) return { marked: 0 }

  const ids = feeds
    .filter(f => isStripePayoutFeed(f.memo, f.sender_reference))
    .map(f => f.id)

  if (ids.length === 0) return { marked: 0 }

  await supabaseAdmin
    .from("td_bank_feeds")
    .update({ status: "outgoing", updated_at: new Date().toISOString() })
    .in("id", ids)

  return { marked: ids.length }
}

/**
 * Returns true if an invoice with this status should be considered for payment matching.
 * Uses a blocklist of terminal statuses — anything not already Paid, Voided, or Cancelled
 * represents money still expected (including Draft invoices created at contract signing).
 * Exported for unit tests.
 */
export function isMatchableInvoiceStatus(invoiceStatus: string): boolean {
  return !new Set(["Paid", "Voided", "Cancelled"]).has(invoiceStatus)
}

/**
 * Calculate the new invoice status and running totals after a payment is applied.
 * Exported for unit tests.
 */
export function resolveInvoiceStatusAfterPayment(
  invoiceTotal: number,
  currentAmountPaid: number,
  feedAmount: number,
): { newStatus: "Paid" | "Partial"; newAmountPaid: number; newAmountDue: number } {
  const newAmountPaid = currentAmountPaid + feedAmount
  const newAmountDue = Math.max(invoiceTotal - newAmountPaid, 0)
  const newStatus = newAmountDue <= 0 ? "Paid" : "Partial"
  return { newStatus, newAmountPaid, newAmountDue }
}

/**
 * Settle ONE invoice from a bank feed: apply `appliedAmount` to it (Paid/Partial),
 * mirror the status to the client_expenses table, and run the activation chain
 * if the invoice is linked to a pending_activation.
 *
 * Extracted VERBATIM from the original manualMatch body so single-match behaviour
 * is unchanged. Shared by `manualMatch` (applies the full feed amount to one
 * invoice) and `manualMatchMulti` (applies each invoice's own balance). Does NOT
 * touch the td_bank_feeds row — the caller owns the feed update.
 *
 * @returns the invoice_number for the caller's MatchResult, or undefined.
 */
async function settleInvoiceFromFeed(
  feedId: string,
  paymentId: string,
  appliedAmount: number,
  now: string,
  today: string,
): Promise<string | undefined> {
  // Check if this is an invoice payment
  const { data: payment } = await supabaseAdmin
    .from("payments")
    .select("invoice_status, invoice_number, total, amount_paid")
    .eq("id", paymentId)
    .single()

  // Update invoice status — partial if applied amount < remaining balance, paid otherwise
  if (payment?.invoice_status && !["Paid", "Voided", "Credit"].includes(payment.invoice_status)) {
    const { newStatus, newAmountPaid, newAmountDue } = resolveInvoiceStatusAfterPayment(
      Number(payment.total ?? 0),
      Number(payment.amount_paid ?? 0),
      appliedAmount,
    )

    // eslint-disable-next-line no-restricted-syntax
    await supabaseAdmin
      .from("payments")
      .update({
        invoice_status: newStatus,
        // status column has a stricter enum — only update to "Paid"; Partial keeps current status
        ...(newStatus === "Paid" ? { status: "Paid", paid_date: today } : {}),
        amount_paid: newAmountPaid,
        amount_due: newAmountDue,
        payment_method: "Wire (Manual Match)",
        updated_at: now,
      })
      .eq("id", paymentId)

    // Sync status to client_expenses mirror
    const { syncTDInvoiceStatus } = await import("@/lib/portal/td-invoice")
    await syncTDInvoiceStatus(
      paymentId,
      newStatus,
      newStatus === "Paid" ? today : undefined,
      newAmountPaid,
    )

    if (newStatus === "Paid") {
      syncPaymentToQB(paymentId, { paymentDate: today }).catch(() => {})
    }
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

  return payment?.invoice_number ?? undefined
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
      .select("amount")
      .eq("id", feedId)
      .single()
    const feedAmount = Number(feed?.amount ?? 0)

    // Update bank feed
    await supabaseAdmin
      .from("td_bank_feeds")
      .update({
        matched_payment_id: paymentId,
        match_confidence: "manual",
        matched_at: now,
        matched_by: "staff",
        status: "matched",
        updated_at: now,
      })
      .eq("id", feedId)

    const invoiceNumber = await settleInvoiceFromFeed(feedId, paymentId, feedAmount, now, today)

    return {
      matched: true,
      paymentId,
      invoiceNumber,
      confidence: "manual",
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
export function partitionInvoicesForMultiMatch<T extends { id: string; invoice_status: string | null }>(
  invoices: T[],
): { applicable: T[]; skippedIds: string[] } {
  const terminal = new Set(["Paid", "Voided", "Cancelled", "Credit"])
  const applicable: T[] = []
  const skippedIds: string[] = []
  for (const inv of invoices) {
    if (inv.invoice_status && terminal.has(inv.invoice_status)) skippedIds.push(inv.id)
    else applicable.push(inv)
  }
  return { applicable, skippedIds }
}

/**
 * Multi-invoice manual match — one incoming transaction that settles SEVERAL
 * invoices (e.g. a single wire paying invoices for two different companies the
 * same person owns: "Partner Alliance" paying for itself + "Morgan & Taylor").
 *
 * Each selected invoice is settled for its OWN remaining balance (marked Paid),
 * NOT an arithmetic split of the feed amount — the caller (UI) shows a running
 * total so staff only confirm when the selection adds up. The feed links to the
 * first applied invoice via `matched_payment_id` (keeps every existing single-FK
 * read valid) and records the full set in `review_metadata.matched_payment_ids`.
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
      .select("status, review_metadata")
      .eq("id", feedId)
      .single()
    if (feed?.status === "matched") {
      return { matched: false, error: "This transaction is already matched." }
    }

    // Fetch all selected invoices at once, then partition into applicable vs
    // terminal (already paid/closed) so a stale/duplicate selection can't double-pay.
    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("id, invoice_status, total, amount_paid")
      .in("id", ids)
    const rows = (payments ?? []) as Array<{ id: string; invoice_status: string | null; total: number | null; amount_paid: number | null }>
    const foundIds = new Set(rows.map((r) => r.id))
    const missing = ids.filter((id) => !foundIds.has(id))
    const { applicable, skippedIds } = partitionInvoicesForMultiMatch(rows)
    const skipped = [...missing, ...skippedIds]

    const applied: string[] = []
    let firstInvoiceNumber: string | undefined
    // Settle in the caller's selection order so `matched_payment_id` (the primary
    // FK) is deterministically the first selected, applicable invoice.
    const applicableById = new Map(applicable.map((r) => [r.id, r]))
    for (const id of ids) {
      const row = applicableById.get(id)
      if (!row) continue
      // Apply this invoice's OWN remaining balance → it goes fully Paid.
      const balance = Math.max(Number(row.total ?? 0) - Number(row.amount_paid ?? 0), 0)
      const invNum = await settleInvoiceFromFeed(feedId, id, balance, now, today)
      if (!firstInvoiceNumber) firstInvoiceNumber = invNum
      applied.push(id)
    }

    if (applied.length === 0) {
      return { matched: false, error: "All selected invoices are already paid or closed — nothing to match." }
    }

    // Link the feed: primary FK = first applied invoice (keeps existing single-read
    // code valid); full set recorded in review_metadata for the audit trail.
    const existingMeta =
      feed?.review_metadata && typeof feed.review_metadata === "object"
        ? (feed.review_metadata as Record<string, unknown>)
        : {}
    await supabaseAdmin
      .from("td_bank_feeds")
      .update({
        matched_payment_id: applied[0],
        match_confidence: "manual",
        matched_at: now,
        matched_by: "staff",
        status: "matched",
        review_metadata: {
          ...existingMeta,
          multi_match: true,
          matched_payment_ids: applied,
          ...(skipped.length ? { multi_match_skipped: skipped } : {}),
        },
        updated_at: now,
      })
      .eq("id", feedId)

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
