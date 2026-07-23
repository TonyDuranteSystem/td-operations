/**
 * CRON: Wizard Form Reminders
 *
 * Runs daily. Finds in-progress wizard forms and sends reminders:
 * - 3 days: Push notification reminder
 * - 7 days: Push notification + create task for Antonio
 *
 * Idempotent per FORM (not per client): dedupes on the notification title, which
 * encodes the form type + company. An earlier header claimed it tracked
 * last_reminded_at on wizard_progress — it never did; the column is unused here.
 *
 * Schedule: Daily via Vercel Cron
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createPortalNotification } from "@/lib/portal/notifications"
import { logCron } from "@/lib/cron-log"
import { wizardLabelFor, buildWizardReminderTitle } from "@/lib/portal/wizard-reminder-copy"
import { isFormationDoneForAccounts } from "@/lib/portal/wizard-reminder-rules"

const REMINDER_3D_MS = 3 * 24 * 60 * 60 * 1000
const REMINDER_7D_MS = 7 * 24 * 60 * 60 * 1000

// How long to wait before repeating a reminder the client has not acted on, and
// how many times to repeat it at all.
//
// The old code used a flat 2-day lookback for BOTH levels and no cap, so a
// "7-day reminder" actually re-fired every 2-3 days, forever. Filippo Bernardini
// received the same Formation reminder 22 times between April and July. That is
// not a reminder, it is noise, and it trains clients to ignore the bell.
//
// A 7-day reminder now genuinely repeats weekly, and stops after MAX_REPEATS.
// Staff are not left blind when it stops: the 7d branch already opens a task so
// someone follows up by hand.
const REPEAT_AFTER_3D_MS = 3 * 24 * 60 * 60 * 1000
const REPEAT_AFTER_7D_MS = 7 * 24 * 60 * 60 * 1000
const MAX_REPEATS = 4

/**
 * Has this client already been reminded about THIS form recently, or too often?
 *
 * Keyed on the notification TITLE, not just the recipient. The old check asked
 * "did this account/contact get any reminder of this level in the window?" — so a
 * client with three in-progress forms had them dedupe against each other, and
 * (because a wizard WITH an account dedupes on account_id while one WITHOUT
 * dedupes on contact_id) two different keys meant two notifications per run.
 * That is the second half of how Filippo reached 22. The title encodes the form
 * type and company, so it identifies the FORM — which is what we mean.
 */
async function alreadyRemindedForThisForm(opts: {
  accountId: string | null
  contactId: string | null
  type: string
  title: string
  repeatAfterMs: number
  now: number
}): Promise<boolean> {
  const { accountId, contactId, type, title, repeatAfterMs, now } = opts
  const scope = accountId ? `account_id.eq.${accountId}` : `contact_id.eq.${contactId}`

  const { data: recent } = await supabaseAdmin
    .from("portal_notifications")
    .select("id")
    .or(scope)
    .eq("type", type)
    .eq("title", title)
    .gte("created_at", new Date(now - repeatAfterMs).toISOString())
    .limit(1)
  if (recent && recent.length > 0) return true

  const { count } = await supabaseAdmin
    .from("portal_notifications")
    .select("id", { count: "exact", head: true })
    .or(scope)
    .eq("type", type)
    .eq("title", title)
  return (count ?? 0) >= MAX_REPEATS
}

type WizardRow = {
  id: string
  wizard_type: string
  account_id: string | null
  contact_id: string | null
  created_at: string
  updated_at: string
}

// Returns true when the underlying work the wizard tracks is already done via another path.
// Formation: company already has a formation_date.
// Onboarding: account portal_tier is 'active' (post-EIN).
// Tax: no tax_returns row with data_received=false exists for the account (all years already received).
// Banking (payset/relay), ITIN, closure: no canonical signal — let the normal reminder logic run.
/**
 * The accounts this wizard should be judged against.
 *
 * A wizard row often has NO account_id — it was started before the company
 * existed, or it is a stray second copy. Every check below used to bail out on
 * `if (!w.account_id) return false`, i.e. "cannot tell, so keep reminding".
 * That disqualified exactly the rows most likely to be stale, and the result was
 * clients chased for months for work they had already finished: Filippo
 * Bernardini received 45 reminders (22 for one stale Formation form) after
 * submitting that form in April; Michele Cotti and Alessandro Federici the same.
 * Measured on production 2026-07-23.
 *
 * So when the wizard has no account, fall back to the CONTACT's accounts and run
 * the identical check against those. This widens how the account is FOUND; it
 * does not weaken what is checked.
 */
async function accountIdsForWizard(w: WizardRow): Promise<string[]> {
  if (w.account_id) return [w.account_id]
  if (!w.contact_id) return []
  const { data } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id")
    .eq("contact_id", w.contact_id)
  return (data ?? []).map(r => r.account_id).filter(Boolean) as string[]
}

async function isWizardCompletedElsewhere(w: WizardRow): Promise<boolean> {
  const accountIds = await accountIdsForWizard(w)
  if (accountIds.length === 0) return false

  if (w.wizard_type === "formation") {
    // Done when EVERY linked company already has a formation date. If any is
    // still forming, the client genuinely has something to complete — which is
    // what keeps a legitimate SECOND company formation being reminded (verified:
    // one client on production has two submitted formation wizards).
    const { data } = await supabaseAdmin
      .from("accounts")
      .select("id, formation_date")
      .in("id", accountIds)
    return isFormationDoneForAccounts(data ?? [])
  }

  if (w.wizard_type === "onboarding") {
    if (!w.account_id) return false
    const { data } = await supabaseAdmin
      .from("accounts")
      .select("portal_tier")
      .eq("id", w.account_id)
      .maybeSingle()
    return data?.portal_tier === "active"
  }

  if (w.wizard_type === "tax" || w.wizard_type === "tax_return") {
    if (!w.account_id) return false
    // The submit handler picks tax_year from the latest tax_returns row with data_received=false.
    // If no such row exists, every year on file is already received → wizard has nothing to collect.
    const { data } = await supabaseAdmin
      .from("tax_returns")
      .select("id")
      .eq("account_id", w.account_id)
      .eq("data_received", false)
      .limit(1)
    return !!data && data.length === 0
  }

  return false
}

// Looks up the company name for the reminder title so a client who owns more
// than one company can tell which company a reminder is about (2026-07-20,
// Luma Beauty Global / THW Global incident — see wizard-reminder-copy.ts).
// Returns null for contact-only wizards (no account yet) or a lookup miss.
async function getCompanyName(accountId: string | null): Promise<string | null> {
  if (!accountId) return null
  const { data } = await supabaseAdmin
    .from("accounts")
    .select("company_name")
    .eq("id", accountId)
    .maybeSingle()
  return data?.company_name ?? null
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = Date.now()
  const results = { reminded_3d: 0, reminded_7d: 0, tasks_created: 0, skipped: 0, auto_closed: 0 }

  // Get all in-progress wizard forms
  const { data: wizards } = await supabaseAdmin
    .from("wizard_progress")
    .select("id, wizard_type, account_id, contact_id, created_at, updated_at")
    .eq("status", "in_progress")
    .limit(100)

  if (!wizards || wizards.length === 0) {
    return NextResponse.json({ ok: true, message: "No in-progress wizards", ...results })
  }

  const pauseTaxReminders = process.env.PAUSE_TAX_REMINDERS === "true"

  for (const w of wizards) {
    const ageMs = now - new Date(w.created_at).getTime()
    const lastUpdateMs = now - new Date(w.updated_at).getTime()
    const label = wizardLabelFor(w.wizard_type)

    // Don't remind someone to fill out a form for something that's already done.
    // The wizard may have been bypassed via another code path (admin entry, CRM action, etc.).
    // When detected, auto-close the wizard to 'submitted' so this loop is the last time we look at it.
    const alreadyDone = await isWizardCompletedElsewhere(w)
    if (alreadyDone) {
      await supabaseAdmin
        .from("wizard_progress")
        .update({ status: "submitted", updated_at: new Date().toISOString() })
        .eq("id", w.id)
      console.warn(
        `[wizard-reminders] Auto-closed wizard ${w.id} for ${w.account_id || w.contact_id} — ${w.wizard_type} already completed.`
      )
      results.auto_closed++
      continue
    }

    // Manual pause switch for tax return reminders (env: PAUSE_TAX_REMINDERS=true)
    if (pauseTaxReminders && (w.wizard_type === "tax" || w.wizard_type === "tax_return")) {
      results.skipped++
      continue
    }

    // Skip if updated recently (client is actively working)
    if (lastUpdateMs < REMINDER_3D_MS) {
      results.skipped++
      continue
    }

    // 7-day reminder: push + create task
    if (ageMs >= REMINDER_7D_MS) {
      const companyName = await getCompanyName(w.account_id)
      const title = buildWizardReminderTitle({ urgency: "7d", wizardType: w.wizard_type, companyName })

      if (await alreadyRemindedForThisForm({
        accountId: w.account_id, contactId: w.contact_id,
        type: "form_reminder_7d", title, repeatAfterMs: REPEAT_AFTER_7D_MS, now,
      })) {
        results.skipped++
        continue
      }

      await createPortalNotification({
        account_id: w.account_id || undefined,
        contact_id: w.contact_id || undefined,
        type: "form_reminder_7d",
        title,
        body: "Your data collection form has been pending for over a week. Please complete it to avoid delays.",
        link: "/portal/wizard",
      })
      results.reminded_7d++

      // Create task for Antonio
      if (w.account_id || w.contact_id) {
        // Get client name for task
        let clientName = "Client"
        if (w.contact_id) {
          const { data: contact } = await supabaseAdmin
            .from("contacts")
            .select("full_name")
            .eq("id", w.contact_id)
            .single()
          if (contact?.full_name) clientName = contact.full_name
        }

        // eslint-disable-next-line no-restricted-syntax -- pre-existing; no task-creation helper in lib/operations yet
        await supabaseAdmin.from("tasks").insert({
          task_title: `Follow up: ${clientName} — ${label.en} form not completed (7+ days)`,
          description: `The ${label.en} wizard has been in progress for over 7 days without completion. Contact the client to check if they need help.`,
          assigned_to: "Antonio",
          priority: "High",
          status: "To Do",
          category: "Client Communication",
          account_id: w.account_id || null,
        })
        results.tasks_created++
      }
    }
    // 3-day reminder: push only
    else if (ageMs >= REMINDER_3D_MS) {
      const companyName = await getCompanyName(w.account_id)
      const title = buildWizardReminderTitle({ urgency: "3d", wizardType: w.wizard_type, companyName })

      if (await alreadyRemindedForThisForm({
        accountId: w.account_id, contactId: w.contact_id,
        type: "form_reminder_3d", title, repeatAfterMs: REPEAT_AFTER_3D_MS, now,
      })) {
        results.skipped++
        continue
      }

      await createPortalNotification({
        account_id: w.account_id || undefined,
        contact_id: w.contact_id || undefined,
        type: "form_reminder_3d",
        title,
        body: "Don't forget to complete your data collection form. It only takes a few minutes.",
        link: "/portal/wizard",
      })
      results.reminded_3d++
    } else {
      results.skipped++
    }
  }

  logCron({
    endpoint: "/api/cron/wizard-reminders",
    status: "success",
    duration_ms: Date.now() - startTime,
    details: results,
  })

  return NextResponse.json({ ok: true, ...results })
}
