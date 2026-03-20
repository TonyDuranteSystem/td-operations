/**
 * CRON: Annual Installment Invoice Generator
 *
 * Runs monthly (1st of each month). Checks if it's January or June
 * and creates installment invoices for ALL active Client accounts.
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
 * Does NOT auto-send invoices. Creates tasks for team to review and send.
 *
 * Schedule: 1st of every month via Vercel Cron
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export async function GET(req: NextRequest) {
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

  try {
    // Get all active Client accounts
    const { data: accounts, error } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name, entity_type, formation_date, account_type, installment_1_amount, installment_2_amount, status")
      .eq("status", "Active")
      .eq("account_type", "Client")

    if (error) throw new Error(error.message)
    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ ok: true, message: "No active Client accounts found." })
    }

    const results: Array<{ company: string; action: string; detail: string }> = []

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

      // Check if invoice already exists for this installment this year
      const invoiceRef = `${installmentLabel} ${year} - ${acct.company_name}`
      const { data: existingPayment } = await supabaseAdmin
        .from("payments")
        .select("id")
        .eq("account_id", acct.id)
        .ilike("description", `%${installmentLabel} ${year}%`)
        .limit(1)

      if (existingPayment?.length) {
        results.push({
          company: acct.company_name,
          action: "exists",
          detail: `${installmentLabel} ${year} already invoiced`,
        })
        continue
      }

      // Create payment record (status: pending)
      const { data: payment, error: payErr } = await supabaseAdmin
        .from("payments")
        .insert({
          account_id: acct.id,
          amount,
          currency: "USD",
          payment_type: installmentNumber === 1 ? "1st_installment" : "2nd_installment",
          status: "pending",
          description: `${installmentLabel} ${year} - ${acct.company_name}`,
          due_date: `${year}-${month === 1 ? "01" : "06"}-01`,
        })
        .select("id")
        .single()

      if (payErr) {
        results.push({ company: acct.company_name, action: "error", detail: payErr.message })
        continue
      }

      results.push({
        company: acct.company_name,
        action: "created",
        detail: `$${amount} USD — payment record ${payment?.id}`,
      })
    }

    // Create task for team to review and send invoices
    const created = results.filter(r => r.action === "created")
    const skipped = results.filter(r => r.action === "skipped")

    if (created.length > 0) {
      const taskDescription = [
        `${installmentLabel} ${year}: ${created.length} invoices to create and send.`,
        `Skipped (post-September): ${skipped.length}`,
        "",
        "Clients to invoice:",
        ...created.map(r => `- ${r.company}: ${r.detail}`),
        "",
        "Steps:",
        "1. Create QB invoice for each client (qb_create_invoice)",
        "2. Create Whop payment link (whop_create_plan under 'LLC Annual Management')",
        "3. Send invoice email with both payment options (wire + card)",
        "4. Track payments via check-wire-payments cron",
      ].join("\n")

      await supabaseAdmin.from("tasks").insert({
        task_title: `[BILLING] ${installmentLabel} ${year} — ${created.length} invoices to send`,
        description: taskDescription,
        assigned_to: "Luca",
        priority: "High",
        category: "Payment",
        status: "To Do",
        due_date: `${year}-${month === 1 ? "01" : "06"}-15`,
        created_by: "System",
      })

      // Email notification to team
      try {
        const { gmailPost } = await import("@/lib/gmail")
        const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">
<h2>[BILLING] ${installmentLabel} ${year}</h2>
<p><strong>${created.length}</strong> invoices to create and send.</p>
<p><strong>${skipped.length}</strong> skipped (post-September rule).</p>
<h3>Clients:</h3>
<ul>${created.map(r => `<li>${r.company} — ${r.detail}</li>`).join("")}</ul>
${skipped.length > 0 ? `<h3>Skipped:</h3><ul>${skipped.map(r => `<li>${r.company} — ${r.detail}</li>`).join("")}</ul>` : ""}
</div>`

        const raw = Buffer.from(
          `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
          `To: support@tonydurante.us\r\n` +
          `Subject: [BILLING] ${installmentLabel} ${year} -- ${created.length} invoices ready\r\n` +
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
      entity_type: "payments",
      summary: `${installmentLabel} ${year}: ${created.length} created, ${skipped.length} skipped, ${results.filter(r => r.action === "exists").length} already exist`,
      details: { installment: installmentNumber, year, results },
    })

    return NextResponse.json({
      ok: true,
      installment: installmentLabel,
      year,
      created: created.length,
      skipped: skipped.length,
      existing: results.filter(r => r.action === "exists").length,
      errors: results.filter(r => r.action === "error").length,
    })
  } catch (err) {
    console.error("[annual-installments]", err)
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
