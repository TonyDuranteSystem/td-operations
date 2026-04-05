/**
 * Bank Feed Matcher — Auto-reconciliation engine
 *
 * Matches incoming bank transactions (td_bank_feeds) against:
 * 1. CRM invoices (payments where invoice_status IN ('Sent', 'Overdue'))
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

    // Filter BOTH status and currency in code — PostgREST .eq()/.in() on custom enums returns wrong results
    const openStatuses = new Set(["Sent", "Overdue", "Partial"])
    const currencyFiltered = (allInvoices || []).filter(inv =>
      openStatuses.has(String(inv.invoice_status)) && String(inv.amount_currency) === feedCurrency
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

      const companyName = ((inv.accounts as unknown as { company_name: string })?.company_name || "").toLowerCase()
      const invoiceNum = (inv.invoice_number || "").toLowerCase()

      // Check if sender/memo/reference contains company name or invoice number
      // Use word boundary regex to avoid substring false matches (e.g. "solution" inside "solutions")
      const nameWords = companyName.split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w))
      const nameMatch = nameWords.length > 0 && nameWords.some(w => {
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
        return re.test(effectiveSender) || re.test(senderLower) || re.test(memoLower) || re.test(refLower)
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
    if (candidates.length === 0) {
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

          const paidCompany = ((inv.accounts as unknown as { company_name: string })?.company_name || "").toLowerCase()
          const paidInvNum = (inv.invoice_number || "").toLowerCase()

          const paidNameWords = paidCompany.split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w))
          const paidNameMatch = paidNameWords.length > 0 && paidNameWords.some(w => {
            const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
            return re.test(feedText)
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

      return { matched: false }
    }


    // Sort by score descending — take the best match
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]

    // Only auto-match if confidence is exact or high
    if (best.confidence === "medium") {
      // Store as potential match but don't auto-reconcile
      await supabaseAdmin
        .from("td_bank_feeds")
        .update({
          matched_payment_id: best.id,
          match_confidence: best.confidence,
          status: "unmatched", // Still needs manual review
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
    await supabaseAdmin
      .from("payments")
      .update({ payment_method: paymentMethod })
      .eq("id", best.id)

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
 * Manual match — used from the reconciliation UI.
 * Links a bank feed to a specific payment and marks both as reconciled.
 */
export async function manualMatch(feedId: string, paymentId: string): Promise<MatchResult> {
  try {
    const now = new Date().toISOString()
    const today = new Date().toISOString().split("T")[0]

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

    // Check if this is an invoice payment
    const { data: payment } = await supabaseAdmin
      .from("payments")
      .select("invoice_status, invoice_number")
      .eq("id", paymentId)
      .single()

    // If it's an invoice, mark as paid via unified system (updates BOTH payments + client_invoices)
    if (payment?.invoice_status && !["Paid", "Voided", "Credit"].includes(payment.invoice_status)) {
      await syncInvoiceStatus("payment", paymentId, "Paid", today)

      // Also set payment_method
      await supabaseAdmin
        .from("payments")
        .update({ payment_method: "Wire (Manual Match)" })
        .eq("id", paymentId)

      syncPaymentToQB(paymentId, { paymentDate: today }).catch(() => {})
    }

    return {
      matched: true,
      paymentId,
      invoiceNumber: payment?.invoice_number ?? undefined,
      confidence: "manual",
    }
  } catch (err) {
    return { matched: false, error: (err as Error).message }
  }
}
