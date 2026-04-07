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
    .select("id, company_name, entity_type, state_of_formation, account_type, drive_folder_id, ra_renewal_date, annual_report_due_date, cmra_renewal_date")
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
      const { data: cmraStage } = await supabaseAdmin
        .from("pipeline_stages")
        .select("stage_name")
        .eq("service_type", "CMRA Mailing Address")
        .order("stage_order")
        .limit(1)

      const { data: newSd } = await supabaseAdmin
        .from("service_deliveries")
        .insert({
          service_type: "CMRA Mailing Address",
          service_name: `CMRA ${year} - ${account.company_name}`,
          account_id: accountId,
          contact_id: contactId,
          current_stage: cmraStage?.[0]?.stage_name || "Lease Created",
          status: "active",
          assigned_to: "Luca",
          notes: `Auto-created from 1st installment ${year}`,
        })
        .select("id")
        .single()

      steps.push({ step: "cmra_sd", status: "ok", detail: `Created: ${newSd?.id}` })
    }

    // Update cmra_renewal_date
    await supabaseAdmin
      .from("accounts")
      .update({ cmra_renewal_date: `${year}-12-31`, updated_at: new Date().toISOString() })
      .eq("id", accountId)
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
      const { data: taxStage } = await supabaseAdmin
        .from("pipeline_stages")
        .select("stage_name")
        .eq("service_type", "Tax Return")
        .order("stage_order")
        .limit(1)

      const { data: newSd } = await supabaseAdmin
        .from("service_deliveries")
        .insert({
          service_type: "Tax Return",
          service_name: `Tax Return ${taxYear} - ${account.company_name}`,
          account_id: accountId,
          contact_id: contactId,
          current_stage: taxStage?.[0]?.stage_name || "Activated",
          status: "active",
          assigned_to: "Luca",
          notes: `Auto-created from 1st installment ${year}. Filing for tax year ${taxYear}.`,
        })
        .select("id")
        .single()

      steps.push({ step: "tax_sd", status: "ok", detail: `Created: ${newSd?.id} (tax year ${taxYear})` })

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

        await supabaseAdmin.from("tax_returns").insert({
          account_id: accountId,
          tax_year: taxYear,
          return_type: returnType,
          status: "Paid - Not Started",
          paid: true,
          paid_date: new Date().toISOString().split("T")[0],
        })
        steps.push({ step: "tax_return_record", status: "ok", detail: `Created for ${taxYear} (${returnType})` })
      }
    }
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
    await supabaseAdmin.from("tasks").insert({
      task_title: `Create lease ${year} -- ${account.company_name}`,
      description: `1st installment paid. Create and send new lease agreement for ${year}.\n\nUse: lease_create(account_id="${accountId}", suite_number="...")\nThen: lease_send(token)`,
      assigned_to: "Luca",
      priority: "High",
      category: "Document",
      status: "To Do",
      due_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      account_id: accountId,
      created_by: "System",
    })
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
        await supabaseAdmin
          .from("tax_returns")
          .update({
            status: tr.status === "Data Received" ? "Data Received" : tr.status,
            notes: `2nd installment paid ${new Date().toISOString().split("T")[0]}. Gate lifted — ready for India.`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", tr.id)

        steps.push({ step: "tax_gate", status: "ok", detail: `Gate lifted for ${account.company_name} (${taxYear})` })
      }
    } else {
      steps.push({ step: "tax_gate", status: "skipped", detail: `No tax_returns record for ${taxYear}` })
    }
  } catch (e) {
    steps.push({ step: "tax_gate", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 2. Advance Tax Return SD if at "Awaiting 2nd Payment" ───
  try {
    const { data: taxSd } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, current_stage")
      .eq("account_id", accountId)
      .eq("service_type", "Tax Return")
      .eq("status", "active")
      .maybeSingle()

    if (taxSd && taxSd.current_stage === "Awaiting 2nd Payment") {
      await supabaseAdmin
        .from("service_deliveries")
        .update({
          current_stage: "Ready for Filing",
          updated_at: new Date().toISOString(),
        })
        .eq("id", taxSd.id)

      steps.push({ step: "tax_sd_advance", status: "ok", detail: `SD ${taxSd.id} -> Ready for Filing` })
    } else if (taxSd) {
      steps.push({ step: "tax_sd_advance", status: "skipped", detail: `SD at "${taxSd.current_stage}", not awaiting payment` })
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
      await supabaseAdmin.from("tasks").insert({
        task_title: `[READY] Send tax return to India -- ${account.company_name} (${taxYear})`,
        description: `2nd installment PAID + data RECEIVED.\nThis client is ready to send to India for tax return preparation.\n\nSend to: tax@adasglobus.com\nSubject format: [Company] - [Client] - [EIN] - [Type]`,
        assigned_to: "Luca",
        priority: "High",
        category: "Tax",
        status: "To Do",
        account_id: accountId,
        created_by: "System",
      })
      steps.push({ step: "india_task", status: "ok", detail: "Data ready + paid — task created to send to India" })
    }
  } catch (e) {
    steps.push({ step: "india_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  return { steps }
}
