/**
 * Put a line in What's New when an unlabelled payment is parked and the payer is a known client (incoming-payments Phase 3).
 * SERVER-ONLY, best effort: it never throws (the webhook has already saved the payment record, which is the real safeguard) and does
 * nothing for a payer who is not a client — the Calendar tab's red count is the notice for those.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { emitUnlabelledPaymentWaitingEvent } from "@/lib/portal/chat-events"

interface ParkedSession {
  id: string
  amount_total: number | null
  currency: string | null
  customer_details: { email: string | null; name: string | null } | null
}

export async function notifyUnlabelledPayment(session: ParkedSession): Promise<{ emitted: boolean; reason?: string }> {
  try {
    const email = session.customer_details?.email?.trim()
    if (!email) return { emitted: false, reason: "no email" }
    const cents = Number(session.amount_total)
    const cur = String(session.currency ?? "").toUpperCase()
    if (!Number.isFinite(cents) || cents <= 0) return { emitted: false, reason: "no amount" }
    const exact = email.replace(/[\\%_]/g, (c) => `\\${c}`)
    const { data: contacts, error } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, account_contacts(account_id)")
      .ilike("email", exact)
      .order("created_at", { ascending: true })
      .limit(1)
    if (error) return { emitted: false, reason: error.message }
    const c = (contacts ?? [])[0] as { id: string; full_name: string | null; account_contacts: Array<{ account_id: string }> | null } | undefined
    if (!c) return { emitted: false, reason: "payer is not a known client" }
    const accounts = Array.from(new Set((c.account_contacts ?? []).map((a) => a.account_id)))
    const symbol = cur === "EUR" ? "€" : cur === "USD" ? "$" : `${cur} `
    const r = await emitUnlabelledPaymentWaitingEvent({
      sessionId: session.id,
      contactId: c.id,
      accountId: accounts.length === 1 ? accounts[0] : null,
      payerName: session.customer_details?.name ?? c.full_name,
      amountText: `${symbol}${(Math.round(cents) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
    })
    return { emitted: r.emitted, reason: r.reason }
  } catch (err) {
    console.error(`[incoming-payments] could not post the What's New line for ${session.id}:`, err instanceof Error ? err.message : err)
    return { emitted: false, reason: "failed" }
  }
}
