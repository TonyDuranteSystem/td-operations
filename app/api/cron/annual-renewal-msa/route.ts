/**
 * CRON: Annual Renewal MSA Generator
 *
 * Runs on January 1st each year. For every active Client account that has
 * installment amounts set, auto-generates a renewal MSA+SOW offer
 * (contract_type='renewal') so the client can sign it in the portal.
 *
 * Flow:
 *   1. January 1 cron fires
 *   2. For each active Client account → create annual_agreements record (draft)
 *   3. Client sees portal banner → clicks "Review & Sign"
 *   4. Client signs → agreement-signed webhook fires
 *   5. Webhook creates 1st installment invoice
 *   6. June cron creates 2nd installment invoice (if annual agreement is signed)
 *
 * Idempotency: skips accounts that already have an annual_agreements record
 * for the current year (checked by account_id + agreement_year).
 *
 * Guard: skips accounts with no installment_1_amount — creates a staff alert task.
 *
 * Schedule: January 1st via Vercel Cron (see vercel.json)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { getRenewalGuard } from "@/lib/billing/renewal-guard"
import type { Json } from "@/lib/database.types"

export async function GET(req: NextRequest) {
  const startTime = Date.now()

  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = new Date()
  const month = now.getMonth() + 1
  const year = now.getFullYear()

  const isSandbox = process.env.SANDBOX_MODE === "1"
  const forceRun = isSandbox && req.nextUrl.searchParams.get("force") === "1"

  if (month !== 1 && !forceRun) {
    return NextResponse.json({ ok: true, message: `Month ${month} — renewal MSA cron only runs in January. Skipping.` })
  }

  try {
    // All active Client accounts (exclude test accounts)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: accounts, error: acctErr } = await (supabaseAdmin as any)
      .from("accounts")
      .select("id, company_name, entity_type, installment_1_amount, installment_2_amount, portal_tier, onboarding_date, formation_date")
      .eq("status", "Active")
      .eq("account_type", "Client")
      .or("is_test.is.null,is_test.eq.false") as {
        data: Array<{
          id: string; company_name: string; entity_type: string | null
          installment_1_amount: number | null; installment_2_amount: number | null
          portal_tier: string | null; onboarding_date: string | null; formation_date: string | null
        }> | null
        error: { message: string } | null
      }

    if (acctErr) throw new Error(acctErr.message)
    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ ok: true, message: "No active Client accounts found." })
    }

    const results: Array<{ company: string; action: string; detail: string; offerId?: string }> = []
    const missingAmounts: string[] = []

    for (const acct of accounts) {
      // Guard: must have installment amounts to generate a meaningful MSA
      if (!acct.installment_1_amount) {
        missingAmounts.push(acct.company_name)
        results.push({ company: acct.company_name, action: "skipped_no_amount", detail: "installment_1_amount not set" })
        continue
      }

      // Year 1 guard + September rule (P5/C4 KB rules)
      // Use onboarding_date (MSA signed date) as canonical TD start; fall back to formation_date
      const tdStartDate = acct.onboarding_date || acct.formation_date
      const { skipAccount, skipJanuary } = getRenewalGuard(tdStartDate, year)

      if (skipAccount) {
        // Year 1: setup fee covers through Dec 31 of their first year — no renewal yet
        results.push({ company: acct.company_name, action: "skipped_year1", detail: `Year 1 client (onboarding: ${tdStartDate}) — renewal starts next year` })
        continue
      }

      // Idempotency: check if annual agreement already exists for this year
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existingAgreement } = await (supabaseAdmin as any)
        .from("annual_agreements")
        .select("id, token, status")
        .eq("account_id", acct.id)
        .eq("agreement_year", year)
        .limit(1)
        .maybeSingle() as { data: { id: string; token: string; status: string } | null }

      if (existingAgreement) {
        results.push({
          company: acct.company_name,
          action: "exists",
          detail: `Annual agreement already exists (${existingAgreement.status}, token: ${existingAgreement.token})`,
          offerId: existingAgreement.id,
        })
        continue
      }

      // Get primary contact for this account
      const { data: contactLink } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id, contacts(id, full_name, email)")
        .eq("account_id", acct.id)
        .limit(1)
        .maybeSingle()

      const contact = contactLink?.contacts as { id: string; full_name: string; email: string } | null
      if (!contact?.email) {
        results.push({ company: acct.company_name, action: "skipped_no_contact", detail: "No primary contact with email found" })
        continue
      }

      const companySlug = acct.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      const token = `renewal-${companySlug}-${year}`
      const today = now.toISOString().slice(0, 10)
      const totalAmount = (acct.installment_1_amount || 0) + (acct.installment_2_amount || 0)

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: newAgreement, error: agErr } = await (supabaseAdmin as any)
          .from("annual_agreements")
          .insert({
            token,
            account_id: acct.id,
            agreement_year: year,
            client_name: contact.full_name,
            client_email: contact.email,
            language: "en",
            payment_type: "bank_transfer",
            status: "draft",
            offer_date: today,
            effective_date: `${year}-01-01`,
            skip_january: skipJanuary,
            bundled_pipelines: ["CMRA Mailing Address", "State RA Renewal", "State Annual Report", "Tax Return"],
            services: [{
              name: "Annual LLC Management",
              price: totalAmount,
              description: "Annual management: RA, Annual Report, CMRA, Tax Return, Client Portal",
            }],
            cost_summary: skipJanuary
              ? [
                  {
                    label: "First Installment (June)",
                    items: [{ name: "Annual Management", price: `$${acct.installment_1_amount?.toLocaleString()}` }],
                    total: `$${acct.installment_1_amount?.toLocaleString()}`,
                  },
                  {
                    label: "Second Installment (June — Year 3+)",
                    items: [{ name: "Annual Management", price: `$${acct.installment_2_amount?.toLocaleString() ?? "0"}` }],
                    total: `$${acct.installment_2_amount?.toLocaleString() ?? "0"}`,
                  },
                ]
              : [
                  {
                    label: "First Installment (January)",
                    items: [{ name: "Annual Management", price: `$${acct.installment_1_amount?.toLocaleString()}` }],
                    total: `$${acct.installment_1_amount?.toLocaleString()}`,
                  },
                  {
                    label: "Second Installment (June)",
                    items: [{ name: "Annual Management", price: `$${acct.installment_2_amount?.toLocaleString() ?? "0"}` }],
                    total: `$${acct.installment_2_amount?.toLocaleString() ?? "0"}`,
                  },
                ],
          })
          .select("id, token")
          .single() as { data: { id: string; token: string } | null; error: { message: string } | null }

        if (agErr || !newAgreement) {
          results.push({ company: acct.company_name, action: "error", detail: agErr?.message || "Insert returned no data" })
          continue
        }

        // Portal notification so the client sees the banner on login
        const portalLink = `${process.env.PORTAL_BASE_URL || "https://portal.tonydurante.us"}/portal/sign?token=${token}`
        await supabaseAdmin.from("portal_notifications").insert({
          account_id: acct.id,
          contact_id: contact.id,
          type: "action_required",
          title: `Annual Agreement ${year} — Signature required`,
          body: `Your ${year} annual agreement is ready for your signature. Sign it to confirm services for this year.`,
          link: portalLink,
        })

        await supabaseAdmin.from("action_log").insert({
          action_type: "create",
          table_name: "annual_agreements",
          record_id: newAgreement.id,
          account_id: acct.id,
          summary: `Auto-created annual agreement ${year} for ${acct.company_name} (token: ${newAgreement.token})`,
          details: { token: newAgreement.token, year, trigger: "annual-renewal-msa-cron" } as unknown as Json,
        })

        results.push({ company: acct.company_name, action: "created", detail: `token: ${newAgreement.token}`, offerId: newAgreement.id })
      } catch (e) {
        results.push({ company: acct.company_name, action: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    const created = results.filter(r => r.action === "created")
    const existing = results.filter(r => r.action === "exists")
    const errors = results.filter(r => r.action === "error")
    const skipped = results.filter(r => r.action.startsWith("skipped"))

    // Staff task
    if (created.length > 0 || missingAmounts.length > 0) {
      const taskLines = [
        `Renewal MSA ${year}: ${created.length} offers created, ${existing.length} already existed.`,
        created.length > 0 ? `\nCreated:\n${created.map(r => `- ${r.company} (${r.detail})`).join("\n")}` : "",
        missingAmounts.length > 0 ? `\n⚠️ Missing installment amounts (ACTION REQUIRED):\n${missingAmounts.map(c => `- ${c}`).join("\n")}` : "",
        errors.length > 0 ? `\nErrors:\n${errors.map(r => `- ${r.company}: ${r.detail}`).join("\n")}` : "",
      ].filter(Boolean).join("")

      // eslint-disable-next-line no-restricted-syntax -- cron summary task
      await supabaseAdmin.from("tasks").insert({
        task_title: `[RENEWAL] MSA ${year} — ${created.length} offers created${missingAmounts.length > 0 ? ` | ⚠️ ${missingAmounts.length} missing amounts` : ""}`,
        description: taskLines,
        assigned_to: "Luca",
        priority: missingAmounts.length > 0 ? "High" : "Normal",
        category: "Document",
        status: missingAmounts.length > 0 ? "To Do" : "Done",
        due_date: `${year}-01-15`,
        created_by: "System",
      })
    }

    // Team email
    if (created.length > 0) {
      try {
        const { gmailPost } = await import("@/lib/gmail")
        const emailSubjectRaw = `[RENEWAL] MSA ${year} — ${created.length} offers auto-created`
        const encodedSubject = `=?utf-8?B?${Buffer.from(emailSubjectRaw).toString("base64")}?=`
        const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">
<h2>Annual Renewal MSA ${year}</h2>
<p><strong>${created.length}</strong> renewal offers auto-generated. Clients will see a portal banner to sign.</p>
${missingAmounts.length > 0 ? `<p style="color:#dc2626">⚠️ <strong>${missingAmounts.length}</strong> accounts skipped — missing installment amounts: ${missingAmounts.join(", ")}</p>` : ""}
<h3>Offers created (draft):</h3>
<ul>${created.map(r => `<li>${r.company} — ${r.detail}</li>`).join("")}</ul>
${errors.length > 0 ? `<h3>Errors:</h3><ul>${errors.map(r => `<li>${r.company}: ${r.detail}</li>`).join("")}</ul>` : ""}
</div>`
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

    await logCron({
      endpoint: "/api/cron/annual-renewal-msa",
      status: errors.length > 0 ? "error" : "success",
      duration_ms: Date.now() - startTime,
      details: { year, created: created.length, existing: existing.length, skipped: skipped.length, errors: errors.length },
    })

    return NextResponse.json({
      ok: true,
      year,
      created: created.length,
      existing: existing.length,
      skipped: skipped.length,
      errors: errors.length,
      missing_amounts: missingAmounts,
    })
  } catch (err) {
    console.error("[annual-renewal-msa]", err)
    await logCron({
      endpoint: "/api/cron/annual-renewal-msa",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
