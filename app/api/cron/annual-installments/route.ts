/**
 * CRON: Annual Installment Invoice Generator + Auto-Send
 *
 * Runs monthly (1st of each month). Only acts in June (2nd installment).
 *
 * Eligibility is decided by the pure `decideJuneInstallment` helper
 * (lib/billing/june-installment-eligibility.ts), which has two regimes:
 *  - 2027 onward (permanent): invoice when a signed annual agreement exists for
 *    the year (every client signs in January from 2027).
 *  - 2026 (transition): agreements were not in use, so invoice when the client
 *    has a 1st-installment record for the year ("paid 1st → owes 2nd"). Clients
 *    with no 1st installment but a Sept–Dec prior-year start (post-September
 *    rule, January skipped) are FLAGGED for manual handling, not auto-invoiced.
 *
 * Amount: ALWAYS the per-account CRM `installment_2_amount` — no hardcoded
 * default. Missing/zero amount → skipped + flagged for the team to set it.
 *
 * Duplicate-safe: skips any account that already has a 2nd-installment invoice
 * for the year (by any route, incl. QB-imported rows with no idempotency key).
 *
 * Credit notes (referral or manual) are auto-applied inside createTDInvoice;
 * a fully-covered installment is marked Paid and fires onSecondInstallmentPaid.
 *
 * DRAFTS ONLY: invoices are created as invoice_status='Draft' and are NOT
 * emailed. The team reviews each draft in the CRM and sends it. A summary task
 * + team email report drafts created, amounts-needed, and flagged accounts.
 *
 * On payment detection (via check-wire-payments cron or Whop webhook):
 * - 1st installment paid -> create 4 recurring SDs (CMRA, RA, AR, Tax Return)
 * - 2nd installment paid -> lift tax return gate (ready to send to India)
 *
 * Schedule: 1st of every month via Vercel Cron
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { logCron } from "@/lib/cron-log"
import { decideJuneInstallment } from "@/lib/billing/june-installment-eligibility"
import type { Json } from "@/lib/database.types"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  // Auth check
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = new Date()
  const month = now.getMonth() + 1 // 1-12
  const isSandbox = process.env.SANDBOX_MODE === "1"
  // Sandbox-only testing affordances (no effect in production):
  //   ?force=1  run outside June
  //   ?year=YYYY exercise a specific regime (e.g. 2027 signed-agreement path)
  //   ?dry=1    compute + report decisions WITHOUT creating invoices or writing
  const forceRun = isSandbox && req.nextUrl.searchParams.get("force") === "1"
  const dryRun = isSandbox && req.nextUrl.searchParams.get("dry") === "1"
  const yearParam = isSandbox ? Number(req.nextUrl.searchParams.get("year")) : NaN
  const year = Number.isInteger(yearParam) && yearParam > 0 ? yearParam : now.getFullYear()

  // Only run in June (2nd installment). The 1st installment is created by the
  // renewal MSA signing via the offer-signed webhook.
  if (month !== 6 && !forceRun) {
    return NextResponse.json({ ok: true, message: `Month ${month} — annual-installments cron only runs in June. Skipping.` })
  }

  const installmentNumber = 2
  const installmentLabel = "2nd Installment"
  const dueDate = `${year}-06-01`

  try {
    // Get all active Client accounts
    const { data: accounts, error } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name, entity_type, account_type, installment_2_amount, status, is_test, onboarding_date, formation_date")
      .eq("status", "Active")
      .eq("account_type", "Client")
      .or("is_test.is.null,is_test.eq.false")

    if (error) throw new Error(error.message)
    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ ok: true, message: "No active Client accounts found." })
    }

    const results: Array<{ company: string; action: string; detail: string; paymentId?: string }> = []

    const norm = (s: string | null | undefined) => (s || "").toLowerCase()

    for (const acct of accounts) {
      // ── Gather the DB facts the pure decision function needs ──

      // 2027+ gate: a signed/completed annual agreement for this year.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: signedAgreement } = await (supabaseAdmin as any)
        .from("annual_agreements")
        .select("id, status")
        .eq("account_id", acct.id)
        .eq("agreement_year", year)
        .in("status", ["signed", "completed"])
        .limit(1)
        .maybeSingle() as { data: { id: string; status: string } | null }

      // All this account's payments, classified in JS to avoid PostgREST quoting
      // issues with the "Installment 1 (Jan)" enum value (comma + parens).
      const { data: pmts } = await supabaseAdmin
        .from("payments")
        .select("installment, description, invoice_status, status, year")
        .eq("account_id", acct.id)
      const rows = (pmts || []) as Array<{ installment: string | null; description: string | null; invoice_status: string | null; status: string | null; year: number | null }>

      // Has a FIRST installment for this year? (paid / overdue / waived — any
      // non-cancelled record). 2026 transition gate: "paid 1st → owes 2nd".
      const hasFirstInstallmentThisYear = rows.some(p =>
        p.status !== "Cancelled" && p.invoice_status !== "Cancelled" &&
        ((p.installment === "Installment 1 (Jan)" && p.year === year) ||
          (norm(p.description).includes("first installment") && (p.year === year || p.year == null))))

      // Already has a SECOND installment? Any route, including QB-imported rows
      // with no idempotency key — closes the double-bill gap. Year-scoped but
      // tolerant of the year-null QB artifacts present in 2026.
      const hasExistingSecondInstallment = rows.some(p =>
        p.status !== "Cancelled" && p.invoice_status !== "Cancelled" &&
        ((p.installment === "Installment 2 (Jun)" && p.year === year) ||
          (norm(p.description).includes("second installment") && (p.year === year || p.year == null))))

      const decision = decideJuneInstallment({
        year,
        account_type: acct.account_type,
        status: acct.status,
        is_test: (acct as { is_test: boolean | null }).is_test ?? null,
        installment_2_amount: acct.installment_2_amount,
        onboarding_date: (acct as { onboarding_date: string | null }).onboarding_date ?? null,
        formation_date: (acct as { formation_date: string | null }).formation_date ?? null,
        hasFirstInstallmentThisYear,
        hasSignedAgreementThisYear: !!signedAgreement,
        hasExistingSecondInstallment,
      })

      // Non-invoice outcomes (skip / exists / needs_amount / flag) — record + move on.
      if (decision.action !== "invoice") {
        results.push({ company: acct.company_name, action: decision.action, detail: decision.reason })
        continue
      }

      const amount = decision.amount
      if (amount == null) {
        results.push({ company: acct.company_name, action: "error", detail: "invoice decision returned no amount" })
        continue
      }

      // Sandbox dry-run: report what WOULD be invoiced, write nothing.
      if (dryRun) {
        results.push({ company: acct.company_name, action: "created", detail: `(dry-run) would invoice $${amount} USD` })
        continue
      }

      const description = `${installmentLabel} ${year} — LLC Annual Management`
      const installmentLabelEnum = "Installment 2 (Jun)"

      // Idempotency key — prevents the same installment being invoiced twice on a
      // cron re-run / retry / concurrent fire. createTDInvoice returns the existing
      // row if this key already exists. (The hasExistingSecondInstallment guard
      // above additionally catches pre-existing invoices created outside this cron.)
      const idempotencyKey = `annual-installment:${acct.id}:${installmentNumber}:${year}`

      try {
        // createTDInvoice auto-applies any outstanding credit notes (referral or
        // manual) on the account — same currency, oldest-first, capped at the bill,
        // leftover carried forward — so we just pass the full installment line.
        // It creates the row as invoice_status='Draft'; this cron intentionally
        // does NOT auto-send — the team reviews each draft and sends it.
        const invoice = await createTDInvoice({
          account_id: acct.id,
          line_items: [{
            description: `LLC Annual Management — ${installmentLabel} ${year}`,
            unit_price: amount,
            quantity: 1,
          }],
          currency: "USD",
          due_date: dueDate,
          message: `Payment for ${installmentLabel} ${year} — LLC Annual Management fee.\nPlease remit payment by wire transfer to the bank details below, or via card using the link provided separately.`,
          idempotency_key: idempotencyKey,
          installment: installmentLabelEnum,
        })

        // If credit fully covered the installment, createTDInvoice marked it Paid
        // and set an explanatory "… − credit = $0 due" description — keep that.
        // Otherwise normalize the description to the historical human-readable label.
        const fullyCovered = invoice.status === "Paid"
        if (!fullyCovered) {
          // eslint-disable-next-line no-restricted-syntax -- targeted post-create field override; createTDInvoice uses first line-item description.
          await supabaseAdmin
            .from("payments")
            .update({ description })
            .eq("id", invoice.paymentId)
        }

        // Fire the normal 2nd-installment-paid effects (lift tax gate, etc.).
        if (fullyCovered) {
          try {
            const { onSecondInstallmentPaid } = await import("@/lib/installment-handler")
            await onSecondInstallmentPaid(acct.id, year)
          } catch { /* non-blocking — team email/task summary still reports the invoice */ }
        }

        const creditNote = invoice.total < amount
          ? ` (credit applied${fullyCovered ? " — fully covered, marked Paid" : ""})`
          : ""
        results.push({
          company: acct.company_name,
          action: "created",
          detail: `${invoice.invoiceNumber} — $${invoice.total} USD${creditNote}`,
          paymentId: invoice.paymentId,
        })
      } catch (e) {
        results.push({
          company: acct.company_name,
          action: "error",
          detail: e instanceof Error ? e.message : String(e),
        })
        continue
      }
    }

    // ── Categorize outcomes. This cron creates DRAFTS only — it does NOT
    //    auto-send. The team reviews each draft in the CRM and sends it. ──
    const created = results.filter(r => r.action === "created")          // draft invoices created
    const needsAmount = results.filter(r => r.action === "needs_amount") // has 1st installment but no CRM amount
    const flagged = results.filter(r => r.action === "flag")            // owes June, no 1st installment — manual review
    const existing = results.filter(r => r.action === "exists")         // 2nd installment already present
    const skipped = results.filter(r => r.action === "skip")            // not eligible
    const errored = results.filter(r => r.action === "error")
    const fullyPaidByCredit = created.filter(r => /fully covered, marked Paid/.test(r.detail))

    if (!dryRun && (created.length > 0 || needsAmount.length > 0 || flagged.length > 0 || errored.length > 0)) {
      const li = (arr: typeof results) => arr.map(r => `<li>${r.company} — ${r.detail}</li>`).join("")

      const taskDescription = [
        `${installmentLabel} ${year}: ${created.length} DRAFT invoices created — review + send each from the CRM (nothing was emailed to clients).`,
        fullyPaidByCredit.length > 0 ? `${fullyPaidByCredit.length} fully covered by credit (auto-marked Paid).` : "",
        needsAmount.length > 0 ? `\n⚠️ Set amount in CRM before invoicing (${needsAmount.length}):` : "",
        ...needsAmount.map(r => `- ${r.company}: ${r.detail}`),
        flagged.length > 0 ? `\n🔎 Review — owes June, no 1st installment (${flagged.length}):` : "",
        ...flagged.map(r => `- ${r.company}: ${r.detail}`),
        created.length > 0 ? "\nDraft invoices:" : "",
        ...created.map(r => `- ${r.company}: ${r.detail}`),
        errored.length > 0 ? `\n❌ Errors (${errored.length}):` : "",
        ...errored.map(r => `- ${r.company}: ${r.detail}`),
      ].filter(Boolean).join("\n")

      const needsAttention = needsAmount.length > 0 || flagged.length > 0 || errored.length > 0

      // eslint-disable-next-line no-restricted-syntax -- billing-cron summary task insert; pre-existing pattern
      await supabaseAdmin.from("tasks").insert({
        task_title: `[BILLING] ${installmentLabel} ${year} — ${created.length} drafts${needsAmount.length > 0 ? ` | ⚠️ ${needsAmount.length} need amount` : ""}${flagged.length > 0 ? ` | 🔎 ${flagged.length} review` : ""}`,
        description: taskDescription,
        assigned_to: "Luca",
        priority: needsAttention ? "High" : "Normal",
        category: "Payment",
        status: "To Do",
        due_date: `${year}-06-15`,
        created_by: "System",
      })

      // Team summary email (no client emails are sent by this cron)
      try {
        const { gmailPost } = await import("@/lib/gmail")
        const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">
<h2>[BILLING] ${installmentLabel} ${year} — DRAFTS</h2>
<p><strong>${created.length}</strong> draft invoices created. Review and send each from the CRM — nothing was emailed to clients.</p>
${fullyPaidByCredit.length > 0 ? `<p>${fullyPaidByCredit.length} fully covered by credit (auto-marked Paid).</p>` : ""}
${needsAmount.length > 0 ? `<p style="color:#dc2626">⚠️ <strong>${needsAmount.length}</strong> need an amount set in the CRM:</p><ul>${li(needsAmount)}</ul>` : ""}
${flagged.length > 0 ? `<p style="color:#b45309">🔎 <strong>${flagged.length}</strong> to review (owes June, no 1st installment):</p><ul>${li(flagged)}</ul>` : ""}
${created.length > 0 ? `<h3>Draft invoices:</h3><ul>${li(created)}</ul>` : ""}
${errored.length > 0 ? `<h3 style="color:#dc2626">Errors:</h3><ul>${li(errored)}</ul>` : ""}
</div>`

        const billingSubject = `[BILLING] ${installmentLabel} ${year} -- ${created.length} drafts created`
        const encodedSubject = `=?utf-8?B?${Buffer.from(billingSubject).toString("base64")}?=`
        const raw = Buffer.from(
          `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
          `To: support@tonydurante.us\r\n` +
          `Subject: ${encodedSubject}\r\n` +
          `MIME-Version: 1.0\r\n` +
          `Content-Type: text/html; charset=utf-8\r\n\r\n` +
          emailBody
        ).toString("base64url")
        await gmailPost("/messages/send", { raw })
      } catch { /* non-blocking */ }
    }

    // Log (skipped on a dry-run — it writes nothing)
    if (!dryRun) {
      await supabaseAdmin.from("action_log").insert({
        action_type: "annual_installment_cron",
        table_name: "payments",
        summary: `${installmentLabel} ${year}: ${created.length} drafts, ${needsAmount.length} need-amount, ${flagged.length} flagged, ${existing.length} existing, ${skipped.length} skipped, ${errored.length} errors`,
        details: { installment: installmentNumber, year, results } as unknown as Json,
      })
    }

    logCron({ endpoint: "/api/cron/annual-installments", status: "success", duration_ms: Date.now() - startTime, details: { installment: installmentLabel, year, dryRun, created: created.length, needsAmount: needsAmount.length, flagged: flagged.length, existing: existing.length, skipped: skipped.length } })

    return NextResponse.json({
      ok: true,
      installment: installmentLabel,
      year,
      dryRun,
      mode: year >= 2027 ? "permanent (signed-agreement gate)" : "transition (1st-installment gate)",
      created: created.length,
      needsAmount: needsAmount.length,
      flagged: flagged.length,
      existing: existing.length,
      skipped: skipped.length,
      errors: errored.length,
    })
  } catch (err) {
    console.error("[annual-installments]", err)
    logCron({ endpoint: "/api/cron/annual-installments", status: "error", duration_ms: Date.now() - startTime, error_message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
