/**
 * CRON: Recurring Invoice Generator (TD → client billing)
 *
 * Runs daily. Reads `recurring_invoice_templates` rows that are active and
 * due (next_run_date <= today, end_date null or >= today) and generates each
 * one via the shared per-cycle generator (lib/billing/recurring-invoice-generate.ts)
 * — the SAME function the "create recurring invoice" dialog action calls for
 * a schedule's very first cycle, so cycle 1 and every later cycle can never
 * silently diverge on which fields persist (Council review, dev job
 * 4a854806, third pass).
 *
 * The template itself is NEVER a `payments` row — the existing recurring
 * pattern on client_invoices only works because that table's template row is
 * inert to the dunning cron and the bank-feed matcher; `payments` has no
 * such immunity, so a template living there would eventually get
 * auto-flagged Overdue and chased, or matched against an unrelated incoming
 * wire.
 *
 * DRAFTS ONLY: invoices are created as invoice_status='Draft' and are NOT
 * emailed. A "What's New" notification (recurring_invoice_generated) is
 * emitted per generated invoice so someone knows to review and send it.
 *
 * ORDERING INVARIANT: next_run_date advances ONLY after createTDInvoice()
 * succeeds for that cycle — enforced inside the shared generator, not here.
 *
 * Schedule: daily via Vercel Cron.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { addDaysToDate } from "@/lib/billing/recurring-invoice-schedule"
import { generateRecurringInvoiceCycle, type RecurringInvoiceTemplateRow } from "@/lib/billing/recurring-invoice-generate"
import type { Json } from "@/lib/database.types"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const isSandbox = process.env.SANDBOX_MODE === "1"
  // Sandbox-only testing affordance (no effect in production): ?dry=1 reports
  // what WOULD be generated without creating invoices or writing anything.
  const dryRun = isSandbox && req.nextUrl.searchParams.get("dry") === "1"
  const today = new Date().toISOString().split("T")[0]

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- recurring_invoice_templates is a new sandbox-only table, not yet in generated types (regenerated on production promotion)
    const { data: due, error } = await (supabaseAdmin as any)
      .from("recurring_invoice_templates")
      .select(
        "id, account_id, contact_id, label, description, line_items, currency, frequency, next_run_date, end_date, due_date_offset_days, installment, payment_category, notes, message, bank_preference, payment_method",
      )
      .eq("active", true)
      .lte("next_run_date", today)
      .or(`end_date.is.null,end_date.gte.${today}`)

    if (error) throw new Error(error.message)
    const templates = (due || []) as RecurringInvoiceTemplateRow[]

    const results: Array<{ label: string; action: "created" | "error" | "would-generate"; detail: string }> = []

    for (const tmpl of templates) {
      if (dryRun) {
        const dueDate = addDaysToDate(tmpl.next_run_date, tmpl.due_date_offset_days ?? 0)
        results.push({ label: tmpl.label, action: "would-generate", detail: `due ${dueDate}` })
        continue
      }
      const result = await generateRecurringInvoiceCycle(tmpl)
      results.push(result)
    }

    const created = results.filter((r) => r.action === "created")
    const errored = results.filter((r) => r.action === "error")

    if (!dryRun) {
      await supabaseAdmin.from("action_log").insert({
        action_type: "recurring_invoice_cron",
        table_name: "recurring_invoice_templates",
        summary: `${created.length} created, ${errored.length} errors, ${templates.length} due`,
        details: { results } as unknown as Json,
      })
    }

    logCron({
      endpoint: "/api/cron/recurring-invoices",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { dryRun, due: templates.length, created: created.length, errors: errored.length },
    })

    return NextResponse.json({ ok: true, dryRun, due: templates.length, created: created.length, errors: errored.length, results })
  } catch (err) {
    console.error("[recurring-invoices]", err)
    logCron({
      endpoint: "/api/cron/recurring-invoices",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
