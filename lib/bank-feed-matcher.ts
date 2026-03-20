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

interface MatchResult {
  matched: boolean
  paymentId?: string
  invoiceNumber?: string
  confidence?: string
  error?: string
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

    // Get all open invoices (Sent or Overdue) in matching currency
    const { data: openInvoices } = await supabaseAdmin
      .from("payments")
      .select("id, account_id, invoice_number, invoice_status, total, amount, amount_currency, description, accounts:account_id(company_name)")
      .in("invoice_status", ["Sent", "Overdue"])
      .eq("amount_currency", feedCurrency)

    if (!openInvoices || openInvoices.length === 0) {
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

    for (const inv of openInvoices) {
      const invAmount = Number(inv.total ?? inv.amount ?? 0)
      const amountDiff = Math.abs(feedAmount - invAmount)
      const tolerance = invAmount * 0.05

      // Skip if amount is way off
      if (amountDiff > tolerance && amountDiff > 1) continue

      const companyName = ((inv.accounts as unknown as { company_name: string })?.company_name || "").toLowerCase()
      const invoiceNum = (inv.invoice_number || "").toLowerCase()

      // Check if sender/memo/reference contains company name or invoice number
      const nameWords = companyName.split(/\s+/).filter(w => w.length > 2)
      const nameMatch = nameWords.some(w =>
        senderLower.includes(w) || memoLower.includes(w) || refLower.includes(w)
      )
      const invoiceRefMatch = invoiceNum && (
        memoLower.includes(invoiceNum) || refLower.includes(invoiceNum)
      )

      let confidence: "exact" | "high" | "medium"
      let score: number

      if (amountDiff < 1 && (nameMatch || invoiceRefMatch)) {
        confidence = "exact"
        score = 100
      } else if (amountDiff < 1) {
        confidence = "high"
        score = 80
      } else if (nameMatch || invoiceRefMatch) {
        confidence = "high"
        score = 70
      } else {
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

    if (candidates.length === 0) {
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

    // Mark invoice as Paid
    const today = new Date().toISOString().split("T")[0]
    await supabaseAdmin
      .from("payments")
      .update({
        status: "Paid",
        invoice_status: "Paid",
        paid_date: today,
        payment_method: feed.source === "relay" ? "Wire (Relay)" : feed.source === "banking_circle" ? "Wire (Banking Circle)" : "Wire",
        updated_at: now,
      })
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

    // If it's an invoice, mark as paid
    if (payment?.invoice_status && !["Paid", "Voided", "Credit"].includes(payment.invoice_status)) {
      await supabaseAdmin
        .from("payments")
        .update({
          status: "Paid",
          invoice_status: "Paid",
          paid_date: today,
          payment_method: "Wire (Manual Match)",
          updated_at: now,
        })
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
