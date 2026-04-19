/**
 * Installment Payment Handler
 *
 * Called when a 1st or 2nd installment payment is confirmed.
 *
 * 1st Installment Paid:
 * - Create 4 recurring SDs for the year: CMRA, RA Renewal, Annual Report, Tax Return
 * - Create new lease agreement (CMRA)
 * - Email team with confirmation
 *
 * 2nd Installment Paid:
 * - Lift tax return gate (ready to send to India)
 * - Update tax_returns status
 * - Email team
 *
 * Rules (from MASTER RULES):
 * - C5: 1st installment triggers 4 recurring SDs
 * - C6: 2nd installment = gate before tax return -> India
 * - P1: No service until paid
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWrite, dbWriteSafe } from "@/lib/db"
import { createSD } from "@/lib/operations/service-delivery"
import { isTaxSeasonPaused } from "@/lib/settings"

interface InstallmentResult {
  steps: Array<{ step: string; status: string; detail?: string }>
}

/**
 * Handle 1st installment payment confirmation
 */
export async function onFirstInstallmentPaid(
  accountId: string,
  year: number,
): Promise<InstallmentResult> {
  const steps: Array<{ step: string; status: string; detail?: string }> = []

  // Get account details
  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, entity_type, state_of_formation, account_type, drive_folder_id, ra_renewal_date, annual_report_due_date, cmra_renewal_date, formation_date")
    .eq("id", accountId)
    .single()

  if (!account) {
    steps.push({ step: "account", status: "error", detail: "Account not found" })
    return { steps }
  }

  if (account.account_type !== "Client") {
    steps.push({ step: "account", status: "skipped", detail: `account_type = ${account.account_type}, not Client. No recurring SDs.` })
    return { steps }
  }

  // Get primary contact
  const { data: contactLink } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id")
    .eq("account_id", accountId)
    .limit(1)
    .maybeSingle()
  const contactId = contactLink?.contact_id || null

  // ─── 1. Create CMRA Mailing Address SD + new lease ───
  try {
    const { data: existingCmra } = await supabaseAdmin
      .from("service_deliveries")
      .select("id")
      .eq("account_id", accountId)
      .eq("service_type", "CMRA Mailing Address")
      .eq("status", "active")
      .limit(1)

    if (existingCmra?.length) {
      steps.push({ step: "cmra_sd", status: "exists", detail: existingCmra[0].id })
    } else {
      const newSd = await createSD({
        service_type: "CMRA Mailing Address",
        service_name: `CMRA ${year} - ${account.company_name}`,
        account_id: accountId,
        contact_id: contactId,
        notes: `Auto-created from 1st installment ${year}`,
      })

      steps.push({ step: "cmra_sd", status: "ok", detail: `Created: ${newSd.id}` })
    }

    // Update cmra_renewal_date
    await dbWriteSafe(
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      supabaseAdmin
        .from("accounts")
        .update({ cmra_renewal_date: `${year}-12-31`, updated_at: new Date().toISOString() })
        .eq("id", accountId),
      "accounts.update"
    )
  } catch (e) {
    steps.push({ step: "cmra_sd", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 2. Create State RA Renewal SD (if due this year) ───
  try {
    const raDate = account.ra_renewal_date
    if (raDate) {
      const raYear = new Date(raDate).getFullYear()
      if (raYear === year) {
        // RA is due this year — the ra-renewal-check cron will handle it
        steps.push({ step: "ra_sd", status: "skipped", detail: `RA due ${raDate} — cron will create SD when 30 days before` })
      } else {
        steps.push({ step: "ra_sd", status: "skipped", detail: `RA not due until ${raDate}` })
      }
    } else {
      steps.push({ step: "ra_sd", status: "skipped", detail: "No ra_renewal_date set" })
    }
  } catch (e) {
    steps.push({ step: "ra_sd", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 3. Create State Annual Report SD (if applicable, not NM) ───
  try {
    const state = (account.state_of_formation || "").toUpperCase()
      .replace("NEW MEXICO", "NM").replace("WYOMING", "WY")
      .replace("FLORIDA", "FL").replace("DELAWARE", "DE")

    if (state === "NM") {
      steps.push({ step: "ar_sd", status: "skipped", detail: "NM — no annual report" })
    } else {
      const arDate = account.annual_report_due_date
      if (arDate) {
        const arYear = new Date(arDate).getFullYear()
        if (arYear === year) {
          steps.push({ step: "ar_sd", status: "skipped", detail: `AR due ${arDate} — cron will create SD when 45 days before` })
        } else {
          steps.push({ step: "ar_sd", status: "skipped", detail: `AR not due until ${arDate}` })
        }
      } else {
        steps.push({ step: "ar_sd", status: "skipped", detail: "No annual_report_due_date set" })
      }
    }
  } catch (e) {
    steps.push({ step: "ar_sd", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 4. Create Tax Return SD ───
  try {
    const taxYear = year - 1 // Filing for previous year

    // Skip if company didn't exist during the tax year
    // A company formed in 2026 doesn't need a 2025 tax return
    const formationYear = account.formation_date ? new Date(account.formation_date).getFullYear() : null
    if (formationYear && formationYear > taxYear) {
      steps.push({ step: "tax_sd", status: "skipped", detail: `Company formed ${account.formation_date} — did not exist in ${taxYear}` })
    } else {

    const { data: existingTr } = await supabaseAdmin
      .from("service_deliveries")
      .select("id")
      .eq("account_id", accountId)
      .eq("service_type", "Tax Return")
      .eq("status", "active")
      .limit(1)

    if (existingTr?.length) {
      steps.push({ step: "tax_sd", status: "exists", detail: existingTr[0].id })
    } else {
      // Tax Return has stage_order=-1 ("Company Data Pending") as its lowest
      // row. For an installment-paid flow where we know the 1st installment
      // IS paid, the correct entry point is stage_order=1 "1st Installment
      // Paid" — createSD defaults to the lowest stage_order, so we pass the
      // explicit target_stage here. When the global tax_season_paused flag is
      // set we park the new SD at on_hold so the client sees the "extension
      // filed" banner instead of the data-collection wizard; the 2nd-
      // installment reactivation cron flips it back to active when season
      // reopens.
      const paused = await isTaxSeasonPaused()
      const newSd = await createSD({
        service_type: "Tax Return",
        service_name: `Tax Return ${taxYear} - ${account.company_name}`,
        account_id: accountId,
        contact_id: contactId,
        target_stage: "1st Installment Paid",
        status: paused ? "on_hold" : "active",
        notes: `Auto-created from 1st installment ${year}. Filing for tax year ${taxYear}.${paused ? " Parked on_hold — tax_season_paused flag set." : ""}`,
      })

      steps.push({ step: "tax_sd", status: "ok", detail: `Created: ${newSd.id}${paused ? " (on_hold — tax season paused)" : ""} (tax year ${taxYear})` })

      // Also create/update tax_returns record
      const { data: existingTrRecord } = await supabaseAdmin
        .from("tax_returns")
        .select("id")
        .eq("account_id", accountId)
        .eq("tax_year", taxYear)
        .limit(1)

      if (!existingTrRecord?.length) {
        const entityType = (account.entity_type || "").toUpperCase()
        let returnType = "SMLLC"
        if (entityType.includes("MULTI") || entityType.includes("MMLLC")) returnType = "MMLLC"
        else if (entityType.includes("CORP")) returnType = "Corp"

        await dbWrite(
          supabaseAdmin.from("tax_returns").insert({
            account_id: accountId,
            tax_year: taxYear,
            return_type: returnType as never,
            status: "Paid - Not Started",
            paid: true,
            paid_date: new Date().toISOString().split("T")[0],
          } as never),
          "tax_returns.insert"
        )
        steps.push({ step: "tax_return_record", status: "ok", detail: `Created for ${taxYear} (${returnType})` })
      }
    }
    } // close formation_date guard
  } catch (e) {
    steps.push({ step: "tax_sd", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 5. Email team ───
  try {
    const { gmailPost } = await import("@/lib/gmail")
    const sdSummary = steps.map(s => `- ${s.step}: ${s.status} ${s.detail || ""}`).join("\n")

    const installment1Subject = `[PAID] 1st Installment ${year} -- ${account.company_name}`
    const encodedSubject = `=?utf-8?B?${Buffer.from(installment1Subject).toString("base64")}?=`
    const raw = Buffer.from(
      `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
      `To: support@tonydurante.us\r\n` +
      `Subject: ${encodedSubject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n\r\n` +
      `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">` +
      `<h2>[PAID] 1st Installment ${year} -- ${account.company_name}</h2>` +
      `<p>Payment confirmed. Recurring services activated for ${year}.</p>` +
      `<pre style="background:#f3f4f6;padding:12px;border-radius:6px">${sdSummary}</pre>` +
      `<p>Next: create and send lease agreement for ${year}.</p>` +
      `</div>`
    ).toString("base64url")
    await gmailPost("/messages/send", { raw })
    steps.push({ step: "email", status: "ok" })
  } catch (e) {
    steps.push({ step: "email", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 6. Create task for lease ───
  try {
    await dbWriteSafe(
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      supabaseAdmin.from("tasks").insert({
        task_title: `Create lease ${year} -- ${account.company_name}`,
        description: `1st installment paid. Create and send new lease agreement for ${year}.\n\nUse: lease_create(account_id="${accountId}", suite_number="...")\nThen: lease_send(token)`,
        assigned_to: "Luca",
        priority: "High",
        category: "Document",
        status: "To Do",
        due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        account_id: accountId,
        created_by: "System",
      }),
      "tasks.insert"
    )
    steps.push({ step: "lease_task", status: "ok" })
  } catch (e) {
    steps.push({ step: "lease_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  return { steps }
}

/**
 * Handle 2nd installment payment confirmation
 */
export async function onSecondInstallmentPaid(
  accountId: string,
  year: number,
): Promise<InstallmentResult> {
  const steps: Array<{ step: string; status: string; detail?: string }> = []

  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name")
    .eq("id", accountId)
    .single()

  if (!account) {
    steps.push({ step: "account", status: "error", detail: "Account not found" })
    return { steps }
  }

  const taxYear = year - 1

  // ─── 1. Update tax_returns: gate lifted ───
  try {
    const { data: tr } = await supabaseAdmin
      .from("tax_returns")
      .select("id, status, sent_to_india")
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
      .maybeSingle()

    if (tr) {
      if (tr.sent_to_india) {
        steps.push({ step: "tax_gate", status: "skipped", detail: "Already sent to India" })
      } else {
        // Gate lifted — ready to send to India
        await dbWrite(
          supabaseAdmin
            .from("tax_returns")
            .update({
              status: tr.status === "Data Received" ? "Data Received" : tr.status,
              notes: `2nd installment paid ${new Date().toISOString().split("T")[0]}. Gate lifted — ready for India.`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", tr.id),
          "tax_returns.update"
        )

        steps.push({ step: "tax_gate", status: "ok", detail: `Gate lifted for ${account.company_name} (${taxYear})` })
      }
    } else {
      steps.push({ step: "tax_gate", status: "skipped", detail: `No tax_returns record for ${taxYear}` })
    }
  } catch (e) {
    steps.push({ step: "tax_gate", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 2. Advance Tax Return SD if at "Awaiting 2nd Payment" ───
  //
  // NOTE: target stage "Ready for Filing" is NOT in the Tax Return
  // pipeline_stages (canonical next stage is "Preparation" stage_order=5).
  // Repo-wide grep shows "Ready for Filing" is written here but read
  // nowhere — it's a silent drift left from an older Tax Return pipeline
  // vocabulary. Kept as a raw `dbWrite` (P1.3-compliant, not P1.6-routed)
  // so P1.6 does not silently change the stage value on live data.
  // Follow-up: reconcile Tax Return stage vocabulary under a dedicated
  // dev_task before routing this advance through advanceStageIfAt (which
  // would throw on the invalid target).
  try {
    const { data: taxSd } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, stage")
      .eq("account_id", accountId)
      .eq("service_type", "Tax Return")
      .eq("status", "active")
      .maybeSingle()

    if (taxSd && taxSd.stage === "Awaiting 2nd Payment") {
      await dbWrite(
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        supabaseAdmin
          .from("service_deliveries")
          .update({
            stage: "Ready for Filing",
            updated_at: new Date().toISOString(),
          })
          .eq("id", taxSd.id),
        "service_deliveries.update"
      )

      steps.push({ step: "tax_sd_advance", status: "ok", detail: `SD ${taxSd.id} -> Ready for Filing` })
    } else if (taxSd) {
      steps.push({ step: "tax_sd_advance", status: "skipped", detail: `SD at "${taxSd.stage}", not awaiting payment` })
    }
  } catch (e) {
    steps.push({ step: "tax_sd_advance", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 3. Email team ───
  try {
    const { gmailPost } = await import("@/lib/gmail")
    const installment2Subject = `[PAID] 2nd Installment ${year} -- ${account.company_name} -- Tax ready for India`
    const encodedSubject2 = `=?utf-8?B?${Buffer.from(installment2Subject).toString("base64")}?=`
    const raw = Buffer.from(
      `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
      `To: support@tonydurante.us\r\n` +
      `Subject: ${encodedSubject2}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n\r\n` +
      `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">` +
      `<h2>[PAID] 2nd Installment ${year} -- ${account.company_name}</h2>` +
      `<p>2nd installment confirmed. Tax return gate lifted.</p>` +
      `<p>If data is received and reviewed, this client's tax return can now be sent to India.</p>` +
      `</div>`
    ).toString("base64url")
    await gmailPost("/messages/send", { raw })
    steps.push({ step: "email", status: "ok" })
  } catch (e) {
    steps.push({ step: "email", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 4. Create task if tax data ready ───
  try {
    const { data: tr } = await supabaseAdmin
      .from("tax_returns")
      .select("id, data_received")
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
      .maybeSingle()

    if (tr?.data_received) {
      await dbWriteSafe(
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        supabaseAdmin.from("tasks").insert({
          task_title: `[READY] Send tax return to India -- ${account.company_name} (${taxYear})`,
          description: `2nd installment PAID + data RECEIVED.\nThis client is ready to send to India for tax return preparation.\n\nSend to: tax@adasglobus.com\nSubject format: [Company] - [Client] - [EIN] - [Type]`,
          assigned_to: "Luca",
          priority: "High",
          category: "Tax" as never,
          status: "To Do",
          account_id: accountId,
          created_by: "System",
        }),
        "tasks.insert"
      )
      steps.push({ step: "india_task", status: "ok", detail: "Data ready + paid — task created to send to India" })
    }
  } catch (e) {
    steps.push({ step: "india_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  return { steps }
}
