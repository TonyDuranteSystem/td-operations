/**
 * CRON: Annual Installment Invoice Generator + Auto-Send
 *
 * Runs monthly (1st of each month). Checks if it's January or June
 * and creates CRM invoices + auto-sends them for ALL active Client accounts.
 *
 * January 1: 1st Installment
 * - SMLLC: $1,000 | MMLLC: $1,250
 * - Post-September rule: skip if formation_date after Sep 1 of previous year
 *
 * June 1: 2nd Installment
 * - SMLLC: $1,000 | MMLLC: $1,250
 * - Post-September first-year clients: this is their FIRST payment
 *
 * On payment detection (via check-wire-payments cron or Whop webhook):
 * - 1st installment paid -> create 4 recurring SDs (CMRA, RA, AR, Tax Return)
 * - 2nd installment paid -> lift tax return gate (ready to send to India)
 *
 * Auto-sends: Creates CRM invoice (with items) → generates PDF → emails client → syncs to QB.
 * Creates a summary task for team visibility.
 *
 * Schedule: 1st of every month via Vercel Cron
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { logCron } from "@/lib/cron-log"
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
  const year = now.getFullYear()

  // Only run in January or June
  if (month !== 1 && month !== 6) {
    return NextResponse.json({ ok: true, message: `Month ${month} — no installments due. Skipping.` })
  }

  const installmentNumber = month === 1 ? 1 : 2
  const installmentLabel = month === 1 ? "1st Installment" : "2nd Installment"
  const dueDate = `${year}-${month === 1 ? "01" : "06"}-01`
  // issueDate previously stamped on the manual payments INSERT (now via createTDInvoice
  // which uses today's date). Removed to satisfy no-unused-vars.

  try {
    // Get all active Client accounts
    const { data: accounts, error } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name, entity_type, formation_date, account_type, installment_1_amount, installment_2_amount, status")
      .eq("status", "Active")
      .eq("account_type", "Client")
      .or("is_test.is.null,is_test.eq.false")

    if (error) throw new Error(error.message)
    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ ok: true, message: "No active Client accounts found." })
    }

    const results: Array<{ company: string; action: string; detail: string; paymentId?: string }> = []

    for (const acct of accounts) {
      // Post-September rule: skip 1st installment for first-year clients formed after Sep 1
      if (installmentNumber === 1 && acct.formation_date) {
        const formDate = new Date(acct.formation_date)
        const formYear = formDate.getFullYear()
        const formMonth = formDate.getMonth() + 1

        // If formed after Sep 1 of the PREVIOUS year, skip January
        if (formYear === year - 1 && formMonth >= 9) {
          results.push({
            company: acct.company_name,
            action: "skipped",
            detail: `Post-September rule: formed ${acct.formation_date}, skip Jan ${year}`,
          })
          continue
        }
      }

      // Determine amount
      const entityUpper = (acct.entity_type || "").toUpperCase()
      let amount: number
      if (installmentNumber === 1) {
        amount = acct.installment_1_amount || (entityUpper.includes("MULTI") || entityUpper.includes("MMLLC") ? 1250 : 1000)
      } else {
        amount = acct.installment_2_amount || (entityUpper.includes("MULTI") || entityUpper.includes("MMLLC") ? 1250 : 1000)
      }

      // Idempotency key — prevents the same installment being invoiced twice
      // (cron re-run, retry, concurrent fire). createTDInvoice will return the
      // existing row if this key already exists.
      const idempotencyKey = `annual-installment:${acct.id}:${installmentNumber}:${year}`

      // Check if already invoiced (by idempotency_key) — preserves the cron's
      // "exists" reporting separately from the auto-create-or-return semantics.
      const { data: existingByKey } = await supabaseAdmin
        .from("payments")
        .select("id, invoice_number")
        .eq("idempotency_key", idempotencyKey)
        .limit(1)
        .maybeSingle()

      if (existingByKey) {
        results.push({
          company: acct.company_name,
          action: "exists",
          detail: `${installmentLabel} ${year} already invoiced (${existingByKey.invoice_number})`,
        })
        continue
      }

      const description = `${installmentLabel} ${year} — LLC Annual Management`
      const installmentLabelEnum = installmentNumber === 1 ? "Installment 1 (Jan)" : "Installment 2 (Jun)"

      try {
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

        // Override description on the payments row so the human-readable label
        // matches the historical convention (createTDInvoice defaults to the
        // first line-item description).
        // eslint-disable-next-line no-restricted-syntax -- targeted post-create field override; createTDInvoice uses first line-item description.
        await supabaseAdmin
          .from("payments")
          .update({ description })
          .eq("id", invoice.paymentId)

        results.push({
          company: acct.company_name,
          action: "created",
          detail: `${invoice.invoiceNumber} — $${amount} USD`,
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

    // Auto-send all created invoices
    const created = results.filter(r => r.action === "created")
    const skipped = results.filter(r => r.action === "skipped")
    const sendResults: Array<{ company: string; sent: boolean; error?: string }> = []

    if (created.length > 0) {
      // Build the internal URL for sending
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000"

      for (const inv of created) {
        if (!inv.paymentId) continue
        try {
          const res = await fetch(`${baseUrl}/api/invoices/${inv.paymentId}/send`, {
            method: "POST",
            headers: {
              // Use cron secret for internal auth — the send route uses dashboard auth,
              // but we need to bypass it for automated sends. Instead, call the send
              // logic directly via a helper.
              "Content-Type": "application/json",
            },
          })
          // The send route requires dashboard auth which we don't have in cron context.
          // Instead, use the direct send approach:
          if (!res.ok) {
            // Fallback: mark as Draft, team will send manually
            sendResults.push({ company: inv.company, sent: false, error: "Auth required — queued for manual send" })
            continue
          }
          sendResults.push({ company: inv.company, sent: true })
        } catch (err) {
          sendResults.push({ company: inv.company, sent: false, error: (err as Error).message })
        }
      }

      // Auto-send via direct Gmail (bypass route auth)
      const failedSends = sendResults.filter(r => !r.sent)
      if (failedSends.length > 0) {
        // Send invoices directly for those that failed the route call
        try {
          const { autoSendInvoices } = await import("@/lib/invoice-auto-send")
          const paymentIds = created
            .filter(c => c.paymentId && failedSends.some(f => f.company === c.company))
            .map(c => c.paymentId!)
          const autoResults = await autoSendInvoices(paymentIds)
          // Update send results
          for (const ar of autoResults) {
            const idx = sendResults.findIndex(r => !r.sent && created.some(c => c.paymentId === ar.paymentId && c.company === r.company))
            if (idx >= 0 && ar.success) {
              sendResults[idx] = { company: sendResults[idx].company, sent: true }
            }
          }
        } catch {
          // Auto-send module not available yet — manual send required
        }
      }

      // Create summary task for team visibility
      const sentCount = sendResults.filter(r => r.sent).length
      const failedCount = sendResults.filter(r => !r.sent).length

      const taskDescription = [
        `${installmentLabel} ${year}: ${created.length} invoices created.`,
        `Auto-sent: ${sentCount} | Manual send needed: ${failedCount}`,
        `Skipped (post-September): ${skipped.length}`,
        "",
        "Invoices:",
        ...created.map(r => {
          const sendStatus = sendResults.find(s => s.company === r.company)
          return `- ${r.company}: ${r.detail} ${sendStatus?.sent ? '✓ Sent' : '⏳ Needs manual send'}`
        }),
      ].join("\n")

      // eslint-disable-next-line no-restricted-syntax -- billing-cron summary task insert; pre-existing pattern
      await supabaseAdmin.from("tasks").insert({
        task_title: `[BILLING] ${installmentLabel} ${year} — ${created.length} invoices (${sentCount} auto-sent)`,
        description: taskDescription,
        assigned_to: "Luca",
        priority: "High",
        category: "Payment",
        status: failedCount > 0 ? "To Do" : "Done",
        due_date: `${year}-${month === 1 ? "01" : "06"}-15`,
        created_by: "System",
      })

      // Email notification to team
      try {
        const { gmailPost } = await import("@/lib/gmail")
        const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">
<h2>[BILLING] ${installmentLabel} ${year}</h2>
<p><strong>${created.length}</strong> invoices created. <strong>${sentCount}</strong> auto-sent. <strong>${failedCount}</strong> need manual send.</p>
<p><strong>${skipped.length}</strong> skipped (post-September rule).</p>
<h3>Invoices:</h3>
<ul>${created.map(r => {
  const s = sendResults.find(sr => sr.company === r.company)
  return `<li>${r.company} — ${r.detail} ${s?.sent ? '✅' : '⏳'}</li>`
}).join("")}</ul>
${skipped.length > 0 ? `<h3>Skipped:</h3><ul>${skipped.map(r => `<li>${r.company} — ${r.detail}</li>`).join("")}</ul>` : ""}
</div>`

        const billingSubject = `[BILLING] ${installmentLabel} ${year} -- ${created.length} invoices (${sentCount} sent)`
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

    // Log
    await supabaseAdmin.from("action_log").insert({
      action_type: "annual_installment_cron",
      table_name: "payments",
      summary: `${installmentLabel} ${year}: ${created.length} created, ${sendResults.filter(r => r.sent).length} sent, ${skipped.length} skipped`,
      details: { installment: installmentNumber, year, results, sendResults } as unknown as Json,
    })

    logCron({ endpoint: "/api/cron/annual-installments", status: "success", duration_ms: Date.now() - startTime, details: { installment: installmentLabel, year, created: created.length, sent: sendResults.filter(r => r.sent).length, skipped: skipped.length } })

    return NextResponse.json({
      ok: true,
      installment: installmentLabel,
      year,
      created: created.length,
      sent: sendResults.filter(r => r.sent).length,
      pendingSend: sendResults.filter(r => !r.sent).length,
      skipped: skipped.length,
      existing: results.filter(r => r.action === "exists").length,
      errors: results.filter(r => r.action === "error").length,
    })
  } catch (err) {
    console.error("[annual-installments]", err)
    logCron({ endpoint: "/api/cron/annual-installments", status: "error", duration_ms: Date.now() - startTime, error_message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
