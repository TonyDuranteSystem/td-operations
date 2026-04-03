/**
 * Referral Tools — Track referrals, commissions, and payouts.
 *
 * Tables: referrals, referral_payouts
 * Referrers are contacts (clients or partners) who refer new clients to TD.
 * Commission types: percentage (10% credit note), price_difference (partner spread), credit_note.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"

export function registerReferralTools(server: McpServer) {

  // ═══════════════════════════════════════
  // referral_create
  // ═══════════════════════════════════════
  server.tool(
    "referral_create",
    "Create a referral record linking a referrer contact to a referred person. The referrer_contact_id must be an existing contact. Use this when a client or partner refers someone new. Returns the created referral with ID.",
    {
      referrer_contact_id: z.string().uuid().describe("Contact UUID of the person who referred (the referrer)"),
      referred_name: z.string().describe("Full name of the person being referred"),
      offer_token: z.string().optional().describe("Offer token if an offer was created for this referral"),
      referred_contact_id: z.string().uuid().optional().describe("Contact UUID of the referred person (if already in CRM)"),
      referred_account_id: z.string().uuid().optional().describe("Account UUID of the referred person's LLC (if created)"),
      referred_lead_id: z.string().uuid().optional().describe("Lead UUID of the referred person (if lead exists)"),
      commission_type: z.enum(["percentage", "price_difference", "credit_note"]).optional().describe("Commission type: percentage (10% credit note), price_difference (partner spread), credit_note"),
      commission_pct: z.number().optional().describe("Commission percentage (e.g., 10 for 10%)"),
      commission_amount: z.number().optional().describe("Pre-calculated commission amount"),
      commission_currency: z.enum(["EUR", "USD"]).optional().default("EUR").describe("Commission currency (default: EUR)"),
      status: z.enum(["pending", "converted", "credited", "paid", "cancelled"]).optional().default("pending").describe("Referral status (default: pending)"),
      notes: z.string().optional().describe("Internal notes about this referral"),
    },
    async (params) => {
      try {
        const insert: Record<string, unknown> = {
          referrer_contact_id: params.referrer_contact_id,
          referred_name: params.referred_name,
          status: params.status || "pending",
          commission_currency: params.commission_currency || "EUR",
        }

        if (params.offer_token) insert.offer_token = params.offer_token
        if (params.referred_contact_id) insert.referred_contact_id = params.referred_contact_id
        if (params.referred_account_id) insert.referred_account_id = params.referred_account_id
        if (params.referred_lead_id) insert.referred_lead_id = params.referred_lead_id
        if (params.commission_type) insert.commission_type = params.commission_type
        if (params.commission_pct != null) insert.commission_pct = params.commission_pct
        if (params.commission_amount != null) insert.commission_amount = params.commission_amount
        if (params.notes) insert.notes = params.notes

        const { data, error } = await supabaseAdmin
          .from("referrals")
          .insert(insert)
          .select()
          .single()

        if (error) throw new Error(error.message)

        logAction({
          action_type: "create",
          table_name: "referrals",
          record_id: data.id,
          summary: `Referral created: ${params.referred_name}`,
          details: { referrer_contact_id: params.referrer_contact_id, referred_name: params.referred_name },
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ Referral created\nID: ${data.id}\nReferrer: ${params.referrer_contact_id}\nReferred: ${params.referred_name}\nStatus: ${data.status}\nCommission: ${data.commission_amount ? `${data.commission_amount} ${data.commission_currency}` : "not set yet"}`,
          }],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error creating referral: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // referral_search
  // ═══════════════════════════════════════
  server.tool(
    "referral_search",
    "Search referrals with optional filters. Returns referrer name, referred name, company name, status, commission details, and dates. Use this to find referrals by referrer, referred person, status, or offer.",
    {
      referrer_contact_id: z.string().uuid().optional().describe("Filter by referrer contact UUID"),
      referred_contact_id: z.string().uuid().optional().describe("Filter by referred contact UUID"),
      referred_account_id: z.string().uuid().optional().describe("Filter by referred account UUID"),
      status: z.enum(["pending", "converted", "credited", "paid", "cancelled"]).optional().describe("Filter by status"),
      offer_token: z.string().optional().describe("Filter by offer token"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
    },
    async (params) => {
      try {
        let q = supabaseAdmin
          .from("referrals")
          .select(`
            id, referrer_contact_id, referred_contact_id, referred_account_id,
            referred_lead_id, referred_name, offer_token, status,
            commission_type, commission_pct, commission_amount, commission_currency,
            credited_amount, paid_amount, notes, is_test, created_at, updated_at,
            referrer:contacts!referrals_referrer_contact_id_fkey(full_name),
            referred_contact:contacts!referrals_referred_contact_id_fkey(full_name),
            referred_account:accounts!referrals_referred_account_id_fkey(company_name)
          `)
          .order("created_at", { ascending: false })
          .limit(Math.min(params.limit || 50, 100))

        if (params.referrer_contact_id) q = q.eq("referrer_contact_id", params.referrer_contact_id)
        if (params.referred_contact_id) q = q.eq("referred_contact_id", params.referred_contact_id)
        if (params.referred_account_id) q = q.eq("referred_account_id", params.referred_account_id)
        if (params.status) q = q.eq("status", params.status)
        if (params.offer_token) q = q.eq("offer_token", params.offer_token)

        const { data, error } = await q
        if (error) throw new Error(error.message)

        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No referrals found." }] }
        }

        const statusIcons: Record<string, string> = {
          pending: "🟡",
          converted: "🔵",
          credited: "🟢",
          paid: "✅",
          cancelled: "❌",
        }

        const lines: string[] = [`📋 Referrals (${data.length})`, ""]

        for (const r of data) {
          const icon = statusIcons[r.status] || "•"
          const referrerName = (r.referrer as unknown as { full_name: string } | null)?.full_name || "Unknown"
          const referredContactName = (r.referred_contact as unknown as { full_name: string } | null)?.full_name
          const companyName = (r.referred_account as unknown as { company_name: string } | null)?.company_name
          const displayReferred = companyName || referredContactName || r.referred_name || "Unknown"
          const commission = r.commission_amount
            ? `${r.commission_amount} ${r.commission_currency}`
            : "TBD"
          const paidInfo = (Number(r.credited_amount) > 0 || Number(r.paid_amount) > 0)
            ? ` (credited: ${r.credited_amount}, paid: ${r.paid_amount})`
            : ""

          lines.push(`${icon} ${referrerName} → ${displayReferred}`)
          lines.push(`   ID: ${r.id}`)
          lines.push(`   Status: ${r.status} | Commission: ${commission}${paidInfo}`)
          if (r.offer_token) lines.push(`   Offer: ${r.offer_token}`)
          if (r.commission_type) lines.push(`   Type: ${r.commission_type}${r.commission_pct ? ` (${r.commission_pct}%)` : ""}`)
          lines.push(`   Created: ${r.created_at?.slice(0, 10)}`)
          if (r.is_test) lines.push(`   ⚠️ TEST DATA`)
          lines.push("")
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error searching referrals: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // referral_update
  // ═══════════════════════════════════════
  server.tool(
    "referral_update",
    "Update a referral record by ID. Can change status, commission_amount, credited_amount, paid_amount, notes, or link to account/contact. Use referral_search first to find the ID.",
    {
      id: z.string().uuid().describe("Referral UUID to update"),
      updates: z.object({
        status: z.enum(["pending", "converted", "credited", "paid", "cancelled"]).optional(),
        commission_type: z.enum(["percentage", "price_difference", "credit_note"]).optional(),
        commission_pct: z.number().optional(),
        commission_amount: z.number().optional(),
        commission_currency: z.enum(["EUR", "USD"]).optional(),
        credited_amount: z.number().optional(),
        paid_amount: z.number().optional(),
        notes: z.string().optional(),
        referred_account_id: z.string().uuid().optional(),
        referred_contact_id: z.string().uuid().optional(),
        referred_lead_id: z.string().uuid().optional(),
        offer_token: z.string().optional(),
      }).describe("Fields to update"),
    },
    async ({ id, updates }) => {
      try {
        const { data, error } = await supabaseAdmin
          .from("referrals")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single()

        if (error) throw new Error(error.message)

        logAction({
          action_type: "update",
          table_name: "referrals",
          record_id: id,
          summary: `Referral updated: ${Object.keys(updates).join(", ")}`,
          details: updates,
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ Referral updated\nID: ${data.id}\nStatus: ${data.status}\nCommission: ${data.commission_amount ?? "TBD"} ${data.commission_currency}\nCredited: ${data.credited_amount} | Paid: ${data.paid_amount}`,
          }],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error updating referral: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // referral_payout
  // ═══════════════════════════════════════
  server.tool(
    "referral_payout",
    "Record a payout against a referral. Creates a referral_payouts record and updates the parent referral's credited/paid amounts. Automatically sets referral status to 'paid' when fully paid, or 'credited' when partially paid. Use referral_search to find the referral_id first.",
    {
      referral_id: z.string().uuid().describe("Referral UUID to pay against"),
      payout_type: z.enum(["credit_note", "bank_transfer", "invoice_deduction"]).describe("Payout method: credit_note (deduct from invoice), bank_transfer (wire to partner), invoice_deduction (reduce next invoice)"),
      amount: z.number().describe("Payout amount"),
      currency: z.enum(["EUR", "USD"]).optional().default("EUR").describe("Currency (default: EUR)"),
      invoice_id: z.string().uuid().optional().describe("Linked invoice UUID (if deducted from invoice)"),
      payment_id: z.string().uuid().optional().describe("Linked payment UUID (if bank transfer)"),
      reference: z.string().optional().describe("External reference number"),
      notes: z.string().optional().describe("Payout notes"),
    },
    async (params) => {
      try {
        // 1. Get the parent referral
        const { data: referral, error: refErr } = await supabaseAdmin
          .from("referrals")
          .select("id, commission_amount, credited_amount, paid_amount, status")
          .eq("id", params.referral_id)
          .single()

        if (refErr || !referral) throw new Error(refErr?.message || "Referral not found")

        // 2. Insert payout record
        const payoutInsert: Record<string, unknown> = {
          referral_id: params.referral_id,
          payout_type: params.payout_type,
          amount: params.amount,
          currency: params.currency || "EUR",
        }
        if (params.invoice_id) payoutInsert.invoice_id = params.invoice_id
        if (params.payment_id) payoutInsert.payment_id = params.payment_id
        if (params.reference) payoutInsert.reference = params.reference
        if (params.notes) payoutInsert.notes = params.notes

        const { data: payout, error: payErr } = await supabaseAdmin
          .from("referral_payouts")
          .insert(payoutInsert)
          .select()
          .single()

        if (payErr) throw new Error(payErr.message)

        // 3. Update parent referral amounts
        const currentCredited = Number(referral.credited_amount) || 0
        const currentPaid = Number(referral.paid_amount) || 0

        let newCredited = currentCredited
        let newPaid = currentPaid

        if (params.payout_type === "credit_note") {
          newCredited += params.amount
        } else {
          newPaid += params.amount
        }

        // Determine new status
        const totalPaid = newCredited + newPaid
        const commissionAmount = Number(referral.commission_amount) || 0
        let newStatus = referral.status
        if (commissionAmount > 0 && totalPaid >= commissionAmount) {
          newStatus = "paid"
        } else if (totalPaid > 0) {
          newStatus = "credited"
        }

        const { error: updateErr } = await supabaseAdmin
          .from("referrals")
          .update({
            credited_amount: newCredited,
            paid_amount: newPaid,
            status: newStatus,
            updated_at: new Date().toISOString(),
          })
          .eq("id", params.referral_id)

        if (updateErr) throw new Error(updateErr.message)

        logAction({
          action_type: "create",
          table_name: "referral_payouts",
          record_id: payout.id,
          summary: `Payout ${params.payout_type}: ${params.amount} ${params.currency || "EUR"} → referral ${params.referral_id}`,
          details: { referral_id: params.referral_id, payout_type: params.payout_type, amount: params.amount, new_status: newStatus },
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ Payout recorded\nPayout ID: ${payout.id}\nType: ${params.payout_type}\nAmount: ${params.amount} ${params.currency || "EUR"}\n\nReferral ${params.referral_id}:\n  Credited: ${newCredited} | Paid: ${newPaid} | Total: ${totalPaid}\n  Commission: ${commissionAmount}\n  Status: ${newStatus}`,
          }],
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error recording payout: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // referral_tracker
  // ═══════════════════════════════════════
  server.tool(
    "referral_tracker",
    "Referral dashboard: status counts, pending/paid commission totals, top referrers, and recent referrals. Use for overview reporting. Optionally filter to a single referrer.",
    {
      referrer_contact_id: z.string().uuid().optional().describe("Filter to a single referrer's stats"),
    },
    async ({ referrer_contact_id }) => {
      try {
        // Build WHERE clause
        const where = referrer_contact_id
          ? `WHERE r.referrer_contact_id = '${referrer_contact_id}'`
          : ""

        // Status counts + commission totals in one query
        const { data: stats, error: statsErr } = await supabaseAdmin.rpc("exec_sql", {
          query: `
            SELECT
              r.status,
              COUNT(*)::int AS count,
              COALESCE(SUM(r.commission_amount), 0)::numeric AS total_commission,
              COALESCE(SUM(r.credited_amount + r.paid_amount), 0)::numeric AS total_paid
            FROM referrals r
            ${where}
            GROUP BY r.status
            ORDER BY r.status
          `,
        })

        // If rpc doesn't exist, fall back to raw query
        let statusRows = stats
        if (statsErr) {
          const { data: fallback } = await supabaseAdmin
            .from("referrals")
            .select("status, commission_amount, credited_amount, paid_amount")
          if (fallback) {
            const grouped: Record<string, { count: number; total_commission: number; total_paid: number }> = {}
            for (const r of fallback) {
              if (referrer_contact_id && r.status === undefined) continue
              const s = r.status || "unknown"
              if (!grouped[s]) grouped[s] = { count: 0, total_commission: 0, total_paid: 0 }
              grouped[s].count++
              grouped[s].total_commission += Number(r.commission_amount) || 0
              grouped[s].total_paid += (Number(r.credited_amount) || 0) + (Number(r.paid_amount) || 0)
            }
            statusRows = Object.entries(grouped).map(([status, v]) => ({ status, ...v }))
          }
        }

        // Top 5 referrers
        const { data: topReferrers } = await supabaseAdmin
          .from("referrals")
          .select("referrer_contact_id, referrer:contacts!referrals_referrer_contact_id_fkey(full_name)")
          .order("created_at", { ascending: false })

        const referrerCounts: Record<string, { name: string; count: number }> = {}
        if (topReferrers) {
          for (const r of topReferrers) {
            if (referrer_contact_id && r.referrer_contact_id !== referrer_contact_id) continue
            const id = r.referrer_contact_id
            if (!id) continue
            const name = (r.referrer as unknown as { full_name: string } | null)?.full_name || "Unknown"
            if (!referrerCounts[id]) referrerCounts[id] = { name, count: 0 }
            referrerCounts[id].count++
          }
        }
        const topList = Object.entries(referrerCounts)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 5)

        // Recent 10 referrals
        let recentQ = supabaseAdmin
          .from("referrals")
          .select(`
            id, referred_name, status, commission_amount, commission_currency, created_at,
            referrer:contacts!referrals_referrer_contact_id_fkey(full_name)
          `)
          .order("created_at", { ascending: false })
          .limit(10)

        if (referrer_contact_id) recentQ = recentQ.eq("referrer_contact_id", referrer_contact_id)

        const { data: recent } = await recentQ

        // Format output
        const lines: string[] = ["📊 REFERRAL TRACKER", ""]

        // Status summary
        const statusIcons: Record<string, string> = {
          pending: "🟡",
          converted: "🔵",
          credited: "🟢",
          paid: "✅",
          cancelled: "❌",
        }

        let totalPending = 0
        let totalPaidOut = 0

        lines.push("═══ STATUS SUMMARY ═══")
        if (statusRows && Array.isArray(statusRows)) {
          for (const row of statusRows) {
            const s = row.status || "unknown"
            const icon = statusIcons[s] || "•"
            lines.push(`${icon} ${s}: ${row.count}  (commission: €${Number(row.total_commission).toFixed(0)}, paid: €${Number(row.total_paid).toFixed(0)})`)
            if (s === "converted") totalPending += Number(row.total_commission) - Number(row.total_paid)
            if (["credited", "paid"].includes(s)) totalPaidOut += Number(row.total_paid)
          }
        }
        lines.push("")
        lines.push(`💰 Pending commission: €${totalPending.toFixed(0)}`)
        lines.push(`✅ Total paid out: €${totalPaidOut.toFixed(0)}`)

        // Top referrers
        if (topList.length > 0 && !referrer_contact_id) {
          lines.push("")
          lines.push("═══ TOP REFERRERS ═══")
          for (const [, { name, count }] of topList) {
            lines.push(`  ${name}: ${count} referral${count > 1 ? "s" : ""}`)
          }
        }

        // Recent referrals
        if (recent && recent.length > 0) {
          lines.push("")
          lines.push("═══ RECENT REFERRALS ═══")
          for (const r of recent) {
            const referrerName = (r.referrer as unknown as { full_name: string } | null)?.full_name || "Unknown"
            const icon = statusIcons[r.status] || "•"
            const amount = r.commission_amount ? `€${r.commission_amount}` : "TBD"
            lines.push(`${icon} ${referrerName} → ${r.referred_name} | ${r.status} | ${amount} | ${r.created_at?.slice(0, 10)}`)
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `❌ Error loading referral tracker: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )
}
