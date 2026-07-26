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
 * - Lift tax return gate (ready to send to accountant)
 * - Update tax_returns status
 * - Email team
 *
 * Rules (from MASTER RULES):
 * - C5: 1st installment triggers 4 recurring SDs
 * - C6: 2nd installment = gate before tax return -> accountant
 * - P1: No service until paid
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWrite, dbWriteSafe } from "@/lib/db"
import { ensureTaxReturnRecord } from "@/lib/tax/ensure-tax-return"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"
import { createSD, advanceStageIfAt } from "@/lib/operations/service-delivery"
import { resolveSecondInstallmentAdvance } from "@/lib/services/stages"
import { isTaxSeasonPaused } from "@/lib/settings"
import { reactivateOnHoldTaxReturns } from "@/lib/tax/reactivation"
import { parsePartnerDeal, shouldPayRenewal } from "@/lib/partners/partner-deal"

interface InstallmentResult {
  steps: Array<{ step: string; status: string; detail?: string }>
}

/**
 * Urgent staff task for tax-tracking gaps the payment chain cannot resolve
 * itself (missing formation date; late-born record needing extension
 * verification). Title-deduped so a handler re-run never duplicates it.
 */
async function createTaxTrackingAlertTask(args: {
  accountId: string
  companyName: string
  title: string
  description: string
}): Promise<{ ok: boolean; detail: string }> {
  const { data: existing } = await supabaseAdmin
    .from("tasks")
    .select("id")
    .eq("account_id", args.accountId)
    .eq("task_title", args.title)
    .limit(1)
    .maybeSingle()
  if (existing) return { ok: true, detail: "alert task already exists" }

  // Raw insert (not dbWriteSafe) so a failure is REPORTED in the step log —
  // a silently-lost alert defeats the alert's purpose.
  // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 tasks.insert; extract to lib/operations/task per dev_task fda76fd3
  const { error } = await supabaseAdmin
    .from("tasks")
    .insert({
      task_title: args.title,
      description: args.description,
      assigned_to: defaultTaskAssignee(),
      priority: "Urgent",
      // 'Filing' — 'Tax' is NOT a task_category enum value (verified 2026-07-17;
      // the old accountant task used it and failed silently for months).
      category: "Filing" as never,
      status: "To Do",
      account_id: args.accountId,
      created_by: "System",
    } as never)
  if (error) return { ok: false, detail: `alert task insert failed: ${error.message}` }
  return { ok: true, detail: "alert task created" }
}

/**
 * Create the partner's renewal payout for ONE installment of a renewal year
 * (Antonio 2026-06-26: two payouts/year, one per installment, each requestable
 * when its own installment is paid). NO split — each installment that is paid
 * yields a payout equal to the FULL agreed renewal amount (`renewal_payout`).
 * Idempotent per (partner, account, year, installment) via reference
 * `renewal:<acct>:<year>:<n>`. Years AFTER formation only (formation year = the
 * one-time setup payout).
 */
async function payInstallmentRenewalShare(args: {
  account: { id: string; company_name: string; partner_id?: string | null; partner_deal?: unknown; formation_date?: string | null }
  year: number
  installmentNumber: 1 | 2
}): Promise<{ step: string; status: string; detail?: string }> {
  const { account, year, installmentNumber } = args
  const stepName = `partner_renewal_payout_${installmentNumber}`
  const partnerId = account.partner_id ?? null
  if (!partnerId) return { step: stepName, status: "skipped", detail: "no partner" }

  const deal = parsePartnerDeal(account.partner_deal)
  const formationYear = account.formation_date ? new Date(account.formation_date).getFullYear() : null
  const decision = shouldPayRenewal({ partnerDeal: deal, formationYear, paymentYear: year })
  if (!decision.pay || !deal) return { step: stepName, status: "skipped", detail: decision.reason }

  const amount = decision.amount // full agreed renewal amount per installment (no split)
  if (amount <= 0) return { step: stepName, status: "skipped", detail: "zero amount" }

  const reference = `renewal:${account.id}:${year}:${installmentNumber}`
  const { data: existing } = await supabaseAdmin
    .from("referral_payouts")
    .select("id")
    .eq("partner_id", partnerId)
    .eq("reference", reference)
    .limit(1)
    .maybeSingle()
  if (existing) return { step: stepName, status: "skipped", detail: `Already created for ${year} installment ${installmentNumber}` }

  const { data: payoutRow } = await dbWriteSafe(
    supabaseAdmin
      .from("referral_payouts")
      // eslint-disable-next-line no-restricted-syntax -- new referral_payouts columns (offer_token/account_id) not yet in generated types; cast until prod migration + regen
      .insert({
        partner_id: partnerId,
        referral_id: null,
        payout_type: "renewal",
        amount,
        currency: deal.currency || "USD",
        status: "pending",
        reference,
        notes: `Annual renewal payout ${year} (installment ${installmentNumber}) for ${account.company_name}`,
        account_id: account.id,
        offer_token: deal.offer_token ?? null,
      } as never)
      .select("id")
      .single(),
    "referral_payouts.insert",
  )
  // No CRM task — the partner self-serves the payout request from their portal.
  return { step: stepName, status: "created", detail: `Renewal payout ${amount} ${deal.currency || "USD"} for ${year} installment ${installmentNumber} (${payoutRow?.id?.slice(0, 8)})` }
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
    .select("id, company_name, entity_type, member_structure, state_of_formation, account_type, drive_folder_id, ra_renewal_date, annual_report_due_date, cmra_renewal_date, formation_date, partner_id, partner_deal")
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

  // ─── 1. Create CMRA Mailing Address SD ───
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

  // ─── 4. Create Tax Return SD + ENSURE the season record ───
  try {
    const taxYear = year - 1 // Filing for previous year

    // Skip if company didn't exist during the tax year
    // A company formed in 2026 doesn't need a 2025 tax return
    const formationYear = account.formation_date ? new Date(account.formation_date).getFullYear() : null
    if (formationYear && formationYear > taxYear) {
      steps.push({ step: "tax_sd", status: "skipped", detail: `Company formed ${account.formation_date} — did not exist in ${taxYear}` })
    } else {

    // 4a. ENSURE THE tax_returns RECORD — FIRST, and INDEPENDENT of the SD
    // branch below (council 2026-07-17): the old inline insert only ran in
    // the SD-creating branch AND had been failing silently since inception
    // (missing NOT NULL company_name/deadline, swallowed by this try/catch).
    // The record is what the season's extension batch and the wizard
    // eligibility gate key off — it must exist from the January payment.
    const ensured = await ensureTaxReturnRecord({
      accountId,
      companyName: account.company_name,
      taxYear,
      status: "Paid - Not Started",
      memberStructure: account.member_structure,
      entityType: account.entity_type,
      formationDate: account.formation_date,
      paid: true,
    })
    steps.push({ step: "tax_return_record", status: ensured.action === "error" ? "error" : "ok", detail: `${ensured.action}${ensured.detail ? ` — ${ensured.detail}` : ""}` })
    if (ensured.action === "skipped_no_formation_date") {
      const alert = await createTaxTrackingAlertTask({
        accountId,
        companyName: account.company_name,
        title: `[MISSING] Formation date — ${account.company_name}: ${taxYear} tax season NOT tracked`,
        description: `1st installment ${year} paid, but the account has NO formation date, so the ${taxYear} tax record was NOT auto-created (fail-closed rule).\nSet the formation date on the account, then create the ${taxYear} tax return record manually.`,
      })
      steps.push({ step: "tax_record_alert", status: alert.ok ? "ok" : "error", detail: alert.detail })
    }

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

      // Record creation moved to step 4a (ensureTaxReturnRecord) — it now
      // runs in BOTH branches and before/independent of createSD. The old
      // inline insert here had NEVER succeeded: it omitted the NOT NULL
      // company_name + deadline columns and the violation was swallowed.
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
      `<p>The ${year} lease is created automatically and placed in the client portal to sign.</p>` +
      `</div>`
    ).toString("base64url")
    await gmailPost("/messages/send", { raw })
    steps.push({ step: "email", status: "ok" })
  } catch (e) {
    steps.push({ step: "email", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 6. Auto-create the renewal lease and put it in the client portal to sign ───
  // The office lease is an annual Jan 1 → Dec 31 agreement. On renewal, create
  // this year's lease and send it straight to the portal to sign — no manual
  // step, no email. Formerly this section only dropped a reminder onto the
  // (now-defunct) staff task list, so renewal leases were routinely forgotten.
  // Idempotent: createLease guards on (account, contract_year); on a duplicate
  // we still (re-)send the existing lease so a partial prior run completes.
  try {
    if (!contactId) {
      steps.push({ step: "lease", status: "skipped", detail: "No linked contact — cannot create lease" })
    } else {
      const { createLease, sendLeaseToPortal } = await import("@/lib/operations/lease")
      const leaseResult = await createLease({
        account_id: accountId,
        contact_id: contactId,
        contract_year: year,
        effective_date: `${year}-01-01`,
        term_start_date: `${year}-01-01`,
        term_end_date: `${year}-12-31`,
        actor: "system:first-installment",
        summary: `Renewal lease ${year} auto-created on 1st installment for ${account.company_name}`,
        details: { source: "first-installment", year },
      })

      if (leaseResult.success && leaseResult.lease) {
        // Only auto-send a lease THIS run created. Never blind-send a
        // pre-existing same-year lease — it may be a staff work-in-progress
        // draft (custom rent/dates) that a human has not finished reviewing.
        const sent = await sendLeaseToPortal(leaseResult.lease.token)
        if (sent.success) {
          steps.push({
            step: "lease",
            status: "created+sent",
            detail: `${leaseResult.lease.token} (${sent.already ? "already in portal" : "now in portal to sign"})`,
          })
        } else {
          steps.push({ step: "lease", status: "error", detail: `Lease ${leaseResult.lease.token} created but send failed: ${sent.error}` })
        }
      } else if (leaseResult.outcome === "duplicate" && leaseResult.existing) {
        steps.push({
          step: "lease",
          status: "exists",
          detail: `A ${year} lease already exists (${leaseResult.existing.status}) — left as-is, not auto-sent. Review/send manually if needed.`,
        })
      } else {
        steps.push({ step: "lease", status: "error", detail: leaseResult.error || "Lease not created" })
      }
    }
  } catch (e) {
    steps.push({ step: "lease", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── Partner renewal payout — installment 1 share (recurring, USD) ───
  // A managed partner earns a renewal share each year the client renews, split
  // per installment. This is the 1st-installment trigger → installment-1 share.
  // ONLY in years AFTER formation (formation year = one-time setup payout).
  try {
    steps.push(await payInstallmentRenewalShare({ account, year, installmentNumber: 1 }))
  } catch (e) {
    steps.push({ step: "partner_renewal_payout_1", status: "error", detail: e instanceof Error ? e.message : String(e) })
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
    // member_structure + entity_type feed the record ensure below (council
    // 2026-07-17: without them a missing-record MMLLC would be created SMLLC
    // with the wrong deadline cohort).
    .select("id, company_name, partner_id, partner_deal, formation_date, member_structure, entity_type")
    .eq("id", accountId)
    .single()

  if (!account) {
    steps.push({ step: "account", status: "error", detail: "Account not found" })
    return { steps }
  }

  const taxYear = year - 1

  // ─── 1. Ensure + update tax_returns: gate lifted ───
  try {
    const { data: tr } = await supabaseAdmin
      .from("tax_returns")
      .select("id, status, sent_to_accountant, notes")
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
      .maybeSingle()

    if (tr) {
      if (tr.sent_to_accountant) {
        steps.push({ step: "tax_gate", status: "skipped", detail: "Already sent to accountant" })
      } else {
        // Gate lifted — ready to send to accountant. Notes APPEND (council:
        // the old wholesale replace erased staff notes on the record).
        const gateLine = `2nd installment paid ${new Date().toISOString().split("T")[0]}. Gate lifted — ready for accountant.`
        await dbWrite(
          supabaseAdmin
            .from("tax_returns")
            .update({
              status: tr.status === "Data Received" ? "Data Received" : tr.status,
              notes: tr.notes ? `${tr.notes}\n${gateLine}` : gateLine,
              updated_at: new Date().toISOString(),
            })
            .eq("id", tr.id),
          "tax_returns.update"
        )

        steps.push({ step: "tax_gate", status: "ok", detail: `Gate lifted for ${account.company_name} (${taxYear})` })
      }
    } else {
      // MISSING RECORD — the gap class (dev job e6136a5e): the old code
      // logged a skip here while step 2 still advanced the SD, leaving a
      // fully-paid client with an open wizard stage but no eligibility
      // token. Create the record now, in the state this payment earns.
      const ensured = await ensureTaxReturnRecord({
        accountId,
        companyName: account.company_name,
        taxYear,
        status: "Wizard Available",
        memberStructure: account.member_structure,
        entityType: account.entity_type,
        formationDate: account.formation_date,
        paid: true,
      })
      steps.push({ step: "tax_gate", status: ensured.action === "error" ? "error" : "ok", detail: `Record was missing — ensure: ${ensured.action}${ensured.detail ? ` (${ensured.detail})` : ""}` })

      if (ensured.action === "skipped_no_formation_date") {
        const alert = await createTaxTrackingAlertTask({
          accountId,
          companyName: account.company_name,
          title: `[MISSING] Formation date — ${account.company_name}: ${taxYear} tax season NOT tracked`,
          description: `2nd installment ${year} paid, but the account has NO formation date, so the ${taxYear} tax record was NOT auto-created (fail-closed rule).\nSet the formation date, create the ${taxYear} tax return record, and verify the client's wizard opens.`,
        })
        steps.push({ step: "tax_record_alert", status: alert.ok ? "ok" : "error", detail: alert.detail })
      } else if (ensured.action === "created" && ensured.bornAfterDeadline) {
        // The season's extension batch works off tax_returns rows — a row
        // born after the nominal deadline could not have been in the batch.
        // Extensions are filed for ALL companies (Antonio's rule), but for
        // THIS company that must be verified, not assumed.
        const alert = await createTaxTrackingAlertTask({
          accountId,
          companyName: account.company_name,
          title: `[VERIFY] Extension — ${account.company_name} (${taxYear}): record created after the deadline`,
          description: `The ${taxYear} tax record was auto-created at 2nd-installment payment, AFTER the nominal filing deadline.\nThis company was invisible to the season's extension batch. Verify its extension was filed; if yes, mark it on the record (extension filed + confirmation id) so the client's deadline shows September/October instead of overdue.`,
        })
        steps.push({ step: "tax_record_alert", status: alert.ok ? "ok" : "error", detail: `late-born record — ${alert.detail}` })
      }
    }
  } catch (e) {
    steps.push({ step: "tax_gate", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 1b. Tax-season pause reactivation — BEFORE the SD advance ───
  // Council 2026-07-17 (was step 2b, AFTER the advance): the advance below
  // only matches status='active', so an SD parked on_hold by the season
  // pause was reactivated too late and stayed at "1st Installment Paid"
  // forever — a fully-paid client with a permanently closed wizard.
  try {
    const reactivation = await reactivateOnHoldTaxReturns(accountId)
    if (reactivation.reactivated > 0) {
      steps.push({ step: "tax_reactivation", status: "ok", detail: `Flipped ${reactivation.reactivated} SD${reactivation.reactivated === 1 ? "" : "s"} on_hold -> active` })
    } else if (reactivation.scanned > 0) {
      steps.push({ step: "tax_reactivation", status: "skipped", detail: `${reactivation.scanned} on_hold SD(s) but 2nd installment not matched` })
    } else {
      steps.push({ step: "tax_reactivation", status: "skipped", detail: "no on_hold Tax Return SD for this account" })
    }
  } catch (e) {
    steps.push({ step: "tax_reactivation", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 2. Advance Tax Return SD to its wizard stage ───
  // 2nd installment paid = the wizard becomes available. The advance rule is
  // DATA-DRIVEN (no hardcoded stage names): resolveSecondInstallmentAdvance
  // reads pipeline_stages and returns the target stage (the one flagged
  // auto_actions.second_installment_target) + the source stages (bundle stages
  // at stage_order >= 1 below the target, EXCLUDING the negative/zero
  // standalone-intake stages, which require the company_info wizard first).
  // Editable in /config. No-op if the SD is already at/after the target
  // (idempotent). Routed through advanceStageIfAt so stage_history, action_log,
  // auto-tasks, portal notification, and tax_returns sync all fire from the
  // canonical helper.
  try {
    const { data: taxSd } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, stage")
      .eq("account_id", accountId)
      .eq("service_type", "Tax Return")
      .eq("status", "active")
      .maybeSingle()

    if (taxSd) {
      const rule = await resolveSecondInstallmentAdvance("Tax Return")
      if (!rule) {
        // No stage flagged as the 2nd-installment target in pipeline_stages.
        // Fail safe + visible rather than guessing a stage name.
        steps.push({
          step: "tax_sd_advance",
          status: "skipped",
          detail: "No 2nd-installment target stage configured (pipeline_stages.auto_actions.second_installment_target)",
        })
      } else {
        const advanceResult = await advanceStageIfAt({
          delivery_id: taxSd.id,
          if_current_stage: rule.source_stages,
          target_stage: rule.target_stage,
          actor: "installment-handler",
          notes: "2nd installment paid",
        })

        if (advanceResult.advanced) {
          steps.push({ step: "tax_sd_advance", status: "ok", detail: `SD ${taxSd.id} -> ${rule.target_stage}` })
        } else if (advanceResult.current_stage && rule.source_stages.includes(advanceResult.current_stage)) {
          // Was at an advanceable stage but the advance itself failed.
          steps.push({
            step: "tax_sd_advance",
            status: "error",
            detail: advanceResult.result?.error || advanceResult.reason || "advanceStageIfAt failed",
          })
        } else {
          // Already at/after the target (idempotent no-op), or at an intake
          // stage we intentionally do not auto-advance.
          steps.push({
            step: "tax_sd_advance",
            status: "skipped",
            detail: `SD at "${advanceResult.current_stage}", no advance needed`,
          })
        }
      }
    } else {
      // Council 2026-07-17: this silence used to be total — a paid client
      // with no active Tax Return SD got a record (step 1) no SD ever
      // opens. Loud step so staff can see the wizard is blocked.
      steps.push({
        step: "tax_sd_advance",
        status: "error",
        detail: "No ACTIVE Tax Return SD — 2nd installment paid but nothing to advance; the client's wizard stays closed until an SD exists",
      })
    }
  } catch (e) {
    steps.push({ step: "tax_sd_advance", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── 3. Email team ───
  try {
    const { gmailPost } = await import("@/lib/gmail")
    const installment2Subject = `[PAID] 2nd Installment ${year} -- ${account.company_name} -- Tax ready for accountant`
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
      `<p>If data is received and reviewed, this client's tax return can now be sent to the accountant.</p>` +
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
      // Idempotent: year-scoped title, skip if it already exists so a second
      // handler run (matcher + cron/manual) does not duplicate the task.
      // Renamed "India" -> "Accountant" 2026-06-09; the dedup match ALSO checks the
      // legacy title so a task created before the rename is not duplicated during
      // the transition window.
      const accountantTitle = `[READY] Send tax return to Accountant -- ${account.company_name} (${taxYear})`
      const legacyIndiaTitle = `[READY] Send tax return to India -- ${account.company_name} (${taxYear})`
      const { data: existingAccountantTask } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .eq("account_id", accountId)
        .in("task_title", [accountantTitle, legacyIndiaTitle])
        .limit(1)
        .maybeSingle()

      if (existingAccountantTask) {
        steps.push({ step: "accountant_task", status: "skipped", detail: "Accountant task already exists for this account/year" })
      } else {
        await dbWriteSafe(
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          supabaseAdmin.from("tasks").insert({
            task_title: accountantTitle,
            description: `2nd installment PAID + data RECEIVED.\nThis client is ready to send to the accountant for tax return preparation.\n\nSend to: tax@adasglobus.com\nSubject format: [Company] - [Client] - [EIN] - [Type]`,
            assigned_to: "Luca",
            priority: "High",
            // 'Filing' — 'Tax' is NOT a task_category enum value; this insert
            // (via dbWriteSafe) had been failing SILENTLY, so the "[READY]
            // Send to Accountant" task never actually existed. Same silent-
            // failure class as the record insert this fix closes. 2026-07-17.
            category: "Filing" as never,
            status: "To Do",
            account_id: accountId,
            created_by: "System",
          }),
          "tasks.insert"
        )
        steps.push({ step: "accountant_task", status: "ok", detail: "Data ready + paid — task created to send to accountant" })
      }
    }
  } catch (e) {
    steps.push({ step: "accountant_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  // ─── Partner renewal payout — installment 2 share (recurring, USD) ───
  // The 2nd-installment trigger → installment-2 share of the annual renewal.
  try {
    steps.push(await payInstallmentRenewalShare({ account, year, installmentNumber: 2 }))
  } catch (e) {
    steps.push({ step: "partner_renewal_payout_2", status: "error", detail: e instanceof Error ? e.message : String(e) })
  }

  return { steps }
}
