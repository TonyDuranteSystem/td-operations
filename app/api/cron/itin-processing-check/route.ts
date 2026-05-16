/**
 * CRON: ITIN IRS-Processing Reminder
 *
 * Runs weekly. For every active itin_irs_processing workflow task:
 *   - If the task has been waiting > 4 weeks since creation
 *   - AND no reminder was sent in the last 4 weeks
 *   - AND the task is within the 16-week max-reminder window
 * → posts a bilingual EN/IT portal message to the client letting them
 *   know we're still waiting on the IRS (no action needed from them).
 * Stamps task_meta.last_irs_reminder_at so the next cron tick debounces.
 *
 * The cron does NOT advance any workflow / SD state — it's purely a
 * "we haven't forgotten" notice. The actual progression happens when the
 * IRS letter arrives and an operator clicks "ITIN number received".
 *
 * Schedule: Mondays at 09:00 UTC (configured in vercel.json).
 *
 * Auth: Bearer CRON_SECRET (same pattern as every other cron in this repo).
 *
 * Slice 5.1-followup of the Workflow System build. See dev_task e364e980.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { decideReminder, buildReminderMessage } from "@/lib/tasks/itin-processing-reminder"
import { updateTask } from "@/lib/operations/task"

export const maxDuration = 60

const ADMIN_SENDER_ID = "b0da5d9c-acf6-4761-9cae-2c3b14dbc631"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = new Date()
  const results: {
    scanned: number
    eligible: number
    sent: number
    skipped: Record<string, number>
    errors: Array<{ task_id: string; error: string }>
  } = {
    scanned: 0,
    eligible: 0,
    sent: 0,
    skipped: { too_recent: 0, already_reminded_recently: 0, max_window_exceeded: 0, invalid_dates: 0 },
    errors: [],
  }

  try {
    // Pull open itin_irs_processing tasks. workflow_slug isn't in the
    // generated types yet (Slice 14 regen), cast via 'as never'.
    const { data: tasks, error: queryErr } = await supabaseAdmin
      .from("tasks")
      .select("id, account_id, contact_id, created_at, task_meta")
      .eq("workflow_slug" as never, "itin_irs_processing")
      .neq("status", "Done")
      .neq("status", "Cancelled")
      .order("created_at", { ascending: true })
    if (queryErr) {
      throw new Error(`tasks query failed: ${queryErr.message}`)
    }

    results.scanned = tasks?.length ?? 0

    for (const raw of tasks ?? []) {
      const task = raw as unknown as {
        id: string
        account_id: string | null
        contact_id: string | null
        created_at: string
        task_meta: Record<string, unknown> | null
      }

      const decision = decideReminder(
        { id: task.id, created_at: task.created_at, task_meta: task.task_meta },
        now,
      )
      if (decision.send === false) {
        const reason = decision.reason
        results.skipped[reason] = (results.skipped[reason] ?? 0) + 1
        continue
      }
      results.eligible += 1

      // Resolve contact for language + first name (for the bilingual message).
      // Prefer task.contact_id; for account-only tasks, look up primary contact.
      let contactId = task.contact_id
      if (!contactId && task.account_id) {
        const { data: primary } = await supabaseAdmin
          .from("account_contacts")
          .select("contact_id")
          .eq("account_id", task.account_id)
          .eq("is_primary", true)
          .maybeSingle()
        contactId = primary?.contact_id ?? null
      }
      if (!contactId) {
        results.errors.push({ task_id: task.id, error: "no contact for reminder" })
        continue
      }

      const { data: contact } = await supabaseAdmin
        .from("contacts")
        .select("full_name, language")
        .eq("id", contactId)
        .maybeSingle()
      const firstName = (contact?.full_name ?? "").split(" ")[0] || "there"
      const language = contact?.language === "it" ? "it" : "en"

      const messageBody = buildReminderMessage({
        first_name: firstName,
        language,
        weeks_since_start: decision.weeks_since_start,
      })

      // Post the portal message.
      const { data: msg, error: msgErr } = await supabaseAdmin
        .from("portal_messages")
        .insert({
          account_id: task.account_id,
          contact_id: contactId,
          sender_type: "admin",
          sender_id: ADMIN_SENDER_ID,
          message: messageBody,
          topic: "ITIN",
          attachments: [],
        })
        .select("id")
        .single()
      if (msgErr || !msg) {
        results.errors.push({
          task_id: task.id,
          error: `portal_messages insert failed: ${msgErr?.message ?? "unknown"}`,
        })
        continue
      }

      // Fire-and-forget client notification (R103 throttled to 1/2h per conversation).
      void (async () => {
        try {
          const { createPortalNotification, notifyClientOfAdminMessage } = await import(
            "@/lib/portal/notifications"
          )
          await createPortalNotification({
            account_id: task.account_id ?? undefined,
            contact_id: contactId ?? undefined,
            type: "chat",
            title: "ITIN status update",
            body: messageBody.slice(0, 100),
            link: "/portal/chat",
          })
          await notifyClientOfAdminMessage({
            account_id: task.account_id,
            contact_id: contactId,
            messagePreview: messageBody,
          })
        } catch (err) {
          console.warn("[itin-processing-check] R103 notification failed:", err)
        }
      })()

      // Stamp task_meta.last_irs_reminder_at so the next cron tick debounces.
      // Routed through updateTask (P2.4 lint compliance + action_log audit).
      const priorCount = ((task.task_meta?.irs_reminder_count as number | undefined) ?? 0)
      const nextMeta = {
        ...(task.task_meta ?? {}),
        last_irs_reminder_at: now.toISOString(),
        irs_reminder_count: priorCount + 1,
      }
      const stamp = await updateTask({
        id: task.id,
        patch: { task_meta: nextMeta } as Parameters<typeof updateTask>[0]["patch"],
        actor: "cron:itin-processing-check",
        summary: `IRS-pending reminder ${priorCount + 1} sent`,
        details: { workflow_slug: "itin_irs_processing", reminder_count: priorCount + 1 },
      })
      if (!stamp.success) {
        results.errors.push({ task_id: task.id, error: `task_meta stamp failed: ${stamp.error}` })
        // The message was sent. The task_meta won't reflect it. Next run
        // will likely send a duplicate — accept that over silently breaking.
      } else {
        results.sent += 1
      }
    }

    const duration = Date.now() - startTime
    logCron({
      endpoint: "/api/cron/itin-processing-check",
      status: results.errors.length > 0 ? "error" : "success",
      duration_ms: duration,
      error_message: results.errors.length > 0 ? `${results.errors.length} task errors` : undefined,
      details: results as unknown as Record<string, unknown>,
    })

    return NextResponse.json({ ok: true, ...results })
  } catch (err) {
    const duration = Date.now() - startTime
    const message = err instanceof Error ? err.message : String(err)
    logCron({
      endpoint: "/api/cron/itin-processing-check",
      status: "error",
      duration_ms: duration,
      error_message: message,
    })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
