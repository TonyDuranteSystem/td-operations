/**
 * Cron: Overdue Payments Report
 * Schedule: daily at 9am ET via Vercel cron
 *
 * Queries payments table for overdue items, generates a summary report,
 * and saves it to system_docs as 'overdue-payments-report'.
 * Consultable via sysdoc_read('overdue-payments-report').
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    // Verify cron secret
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 1. Get overdue payments with account + contact info
    const { data: overdue, error: err } = await supabase
      .from("payments")
      .select(`
        id, amount, amount_currency, due_date, status, description, installment,
        account_id, contact_id,
        accounts!payments_account_id_fkey(company_name),
        contacts!payments_contact_id_fkey(full_name, email)
      `)
      .eq("status", "Overdue")
      .order("due_date", { ascending: true })

    if (err) {
      console.error("[overdue-report] Query failed:", err.message)
      return NextResponse.json({ error: err.message }, { status: 500 })
    }

    if (!overdue || overdue.length === 0) {
      // Save clean report
      await upsertReport("No overdue payments found.", 0, [])
      return NextResponse.json({ message: "No overdue payments", count: 0 })
    }

    // 2. Build report grouped by days overdue
    const now = new Date()
    const buckets = {
      critical: [] as typeof overdue,   // 60+ days
      warning: [] as typeof overdue,    // 30-59 days
      recent: [] as typeof overdue,     // 1-29 days
    }

    let totalAmount = 0
    for (const p of overdue) {
      const dueDate = new Date(p.due_date + "T00:00:00")
      const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      const enriched = { ...p, days_overdue: daysOverdue }

      totalAmount += Number(p.amount) || 0

      if (daysOverdue >= 60) buckets.critical.push(enriched)
      else if (daysOverdue >= 30) buckets.warning.push(enriched)
      else buckets.recent.push(enriched)
    }

    // 3. Format report
    const lines: string[] = [
      `# Overdue Payments Report`,
      `Generated: ${now.toISOString().slice(0, 16)} UTC`,
      ``,
      `## Summary`,
      `- **Total overdue**: ${overdue.length} payments`,
      `- **Total amount**: $${totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      `- Critical (60+ days): ${buckets.critical.length}`,
      `- Warning (30-59 days): ${buckets.warning.length}`,
      `- Recent (1-29 days): ${buckets.recent.length}`,
      ``,
    ]

    const formatBucket = (label: string, items: typeof overdue) => {
      if (items.length === 0) return
      lines.push(`## ${label}`)
      for (const p of items) {
        const account = (p as Record<string, unknown>).accounts as { company_name: string } | null
        const contact = (p as Record<string, unknown>).contacts as { full_name: string; email: string } | null
        const daysOverdue = (p as Record<string, unknown>).days_overdue as number
        lines.push(
          `- **${account?.company_name || "N/A"}** — $${p.amount} ${p.amount_currency || "USD"} ` +
          `(due: ${p.due_date}, ${daysOverdue}d overdue) ` +
          `${p.description || p.installment || ""} ` +
          `[${contact?.full_name || "no contact"}]`
        )
      }
      lines.push(``)
    }

    formatBucket("Critical (60+ days)", buckets.critical)
    formatBucket("Warning (30-59 days)", buckets.warning)
    formatBucket("Recent (1-29 days)", buckets.recent)

    const reportContent = lines.join("\n")

    // 4. Save to system_docs
    await upsertReport(reportContent, overdue.length, {
      critical: buckets.critical.length,
      warning: buckets.warning.length,
      recent: buckets.recent.length,
      total_amount: totalAmount,
    })

    console.warn(`[overdue-report] Report saved: ${overdue.length} overdue payments`)

    logCron({
      endpoint: '/api/cron/overdue-payments-report',
      status: 'success',
      duration_ms: Date.now() - startTime,
      details: { count: overdue.length, critical: buckets.critical.length, warning: buckets.warning.length, recent: buckets.recent.length },
    })

    return NextResponse.json({
      message: "Report generated",
      count: overdue.length,
      critical: buckets.critical.length,
      warning: buckets.warning.length,
      recent: buckets.recent.length,
    })
  } catch (err) {
    console.error("[overdue-report] Error:", err)
    logCron({
      endpoint: '/api/cron/overdue-payments-report',
      status: 'error',
      duration_ms: Date.now() - startTime,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

async function upsertReport(content: string, count: number, summary: unknown) {
  const slug = "overdue-payments-report"

  // Check if exists
  const { data: existing } = await supabase
    .from("system_docs")
    .select("id")
    .eq("slug", slug)
    .limit(1)

  if (existing?.length) {
    await supabase
      .from("system_docs")
      .update({
        content,
        metadata: { count, summary, generated_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      })
      .eq("slug", slug)
  } else {
    await supabase
      .from("system_docs")
      .insert({
        slug,
        title: "Overdue Payments Report",
        content,
        metadata: { count, summary, generated_at: new Date().toISOString() },
      })
  }
}
