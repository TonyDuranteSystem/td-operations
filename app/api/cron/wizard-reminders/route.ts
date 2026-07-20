/**
 * CRON: Wizard Form Reminders
 *
 * Runs daily. Finds in-progress wizard forms and sends reminders:
 * - 3 days: Push notification reminder
 * - 7 days: Push notification + create task for Antonio
 *
 * Idempotent: tracks last_reminded_at on wizard_progress to avoid spam.
 *
 * Schedule: Daily via Vercel Cron
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createPortalNotification } from "@/lib/portal/notifications"
import { logCron } from "@/lib/cron-log"
import { wizardLabelFor, buildWizardReminderTitle } from "@/lib/portal/wizard-reminder-copy"

const REMINDER_3D_MS = 3 * 24 * 60 * 60 * 1000
const REMINDER_7D_MS = 7 * 24 * 60 * 60 * 1000

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
async function isWizardCompletedElsewhere(w: WizardRow): Promise<boolean> {
  if (w.wizard_type === "formation") {
    if (!w.account_id) return false
    const { data } = await supabaseAdmin
      .from("accounts")
      .select("formation_date")
      .eq("id", w.account_id)
      .maybeSingle()
    return !!data?.formation_date
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
      // Check if we already reminded at 7d level
      const { data: existing } = await supabaseAdmin
        .from("portal_notifications")
        .select("id")
        .or(
          w.account_id
            ? `account_id.eq.${w.account_id}`
            : `contact_id.eq.${w.contact_id}`
        )
        .eq("type", "form_reminder_7d")
        .gte("created_at", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString())
        .limit(1)

      if (existing && existing.length > 0) {
        results.skipped++
        continue
      }

      const companyName = await getCompanyName(w.account_id)

      await createPortalNotification({
        account_id: w.account_id || undefined,
        contact_id: w.contact_id || undefined,
        type: "form_reminder_7d",
        title: buildWizardReminderTitle({ urgency: "7d", wizardType: w.wizard_type, companyName }),
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
      // Check if we already reminded at 3d level
      const { data: existing } = await supabaseAdmin
        .from("portal_notifications")
        .select("id")
        .or(
          w.account_id
            ? `account_id.eq.${w.account_id}`
            : `contact_id.eq.${w.contact_id}`
        )
        .eq("type", "form_reminder_3d")
        .gte("created_at", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString())
        .limit(1)

      if (existing && existing.length > 0) {
        results.skipped++
        continue
      }

      const companyName = await getCompanyName(w.account_id)

      await createPortalNotification({
        account_id: w.account_id || undefined,
        contact_id: w.contact_id || undefined,
        type: "form_reminder_3d",
        title: buildWizardReminderTitle({ urgency: "3d", wizardType: w.wizard_type, companyName }),
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
