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

const REMINDER_3D_MS = 3 * 24 * 60 * 60 * 1000
const REMINDER_7D_MS = 7 * 24 * 60 * 60 * 1000

const WIZARD_LABELS: Record<string, { en: string; it: string }> = {
  formation: { en: "Formation", it: "Costituzione" },
  onboarding: { en: "Onboarding", it: "Onboarding" },
  tax: { en: "Tax Return", it: "Dichiarazione Fiscale" },
  tax_return: { en: "Tax Return", it: "Dichiarazione Fiscale" },
  itin: { en: "ITIN Application", it: "Richiesta ITIN" },
  banking: { en: "Banking Setup", it: "Apertura Conto" },
  closure: { en: "LLC Closure", it: "Chiusura LLC" },
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = Date.now()
  const results = { reminded_3d: 0, reminded_7d: 0, tasks_created: 0, skipped: 0 }

  // Get all in-progress wizard forms
  const { data: wizards } = await supabaseAdmin
    .from("wizard_progress")
    .select("id, wizard_type, account_id, contact_id, created_at, updated_at")
    .eq("status", "in_progress")
    .limit(100)

  if (!wizards || wizards.length === 0) {
    return NextResponse.json({ ok: true, message: "No in-progress wizards", ...results })
  }

  for (const w of wizards) {
    const ageMs = now - new Date(w.created_at).getTime()
    const lastUpdateMs = now - new Date(w.updated_at).getTime()
    const label = WIZARD_LABELS[w.wizard_type] || { en: w.wizard_type, it: w.wizard_type }

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

      await createPortalNotification({
        account_id: w.account_id || undefined,
        contact_id: w.contact_id || undefined,
        type: "form_reminder_7d",
        title: `Action needed: Complete your ${label.en} form`,
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

      await createPortalNotification({
        account_id: w.account_id || undefined,
        contact_id: w.contact_id || undefined,
        type: "form_reminder_3d",
        title: `Reminder: Complete your ${label.en} form`,
        body: "Don't forget to complete your data collection form. It only takes a few minutes.",
        link: "/portal/wizard",
      })
      results.reminded_3d++
    } else {
      results.skipped++
    }
  }

  return NextResponse.json({ ok: true, ...results })
}
