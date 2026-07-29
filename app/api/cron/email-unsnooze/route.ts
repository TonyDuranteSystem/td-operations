import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailGet, gmailPost } from "@/lib/gmail"
import { SNOOZE_LABEL_NAME, decideWakeAction } from "@/lib/inbox/email-snooze"
import { resolveMailbox } from "@/lib/inbox/mailbox"

export const dynamic = "force-dynamic"

/**
 * Wake snoozed emails whose time has come (every 10 min, vercel.json).
 *
 * Acts ONLY on email_snoozes rows — NEVER by sweeping the "Snoozed" Gmail
 * label: the label predates this feature (manually-filed threads live there),
 * and sandbox + production run this cron against the SAME real mailboxes, so
 * each environment must only ever touch the threads its own table snoozed.
 * That table-scoping is what makes the double-cron safe — do not "optimize"
 * it into a label sweep (council bug-hunter, 2026-07-28).
 *
 * Per-row order: Gmail first, row-delete second — a rerun of the Gmail modify
 * is idempotent, while deleting the row first and failing the modify strands
 * a client email out of the Inbox forever. The row delete is CONDITIONAL on
 * the due time we selected, so a re-snooze that lands mid-run isn't destroyed
 * by the in-flight wake (TOCTOU guard, same discipline as reviewed_at).
 */
export async function GET(request: NextRequest) {
  // Fail CLOSED: this cron writes to real Gmail. No secret configured = no run
  // (the older read-only crons' fail-open pattern is not acceptable here).
  const secret = process.env.CRON_SECRET
  const authHeader = request.headers.get("authorization")
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const nowIso = new Date().toISOString()
  // email_snoozes is not in the generated DB types yet — same cast pattern as
  // worker_prepared_sends (a types resync is a known prod-build hazard).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: due, error } = await db
    .from("email_snoozes")
    .select("id, mailbox, thread_id, snooze_until, snoozed_last_message_id")
    .lte("snooze_until", nowIso)
    .limit(50)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!due || due.length === 0) {
    return NextResponse.json({ woke: 0, cancelled: 0, failed: 0 })
  }

  // Per-mailbox Snoozed label id, resolved once per run. Label ids are
  // mailbox-scoped — never reuse one mailbox's id for the other.
  const labelIds = new Map<string, string>()
  const snoozeLabelFor = async (asUser: string): Promise<string | null> => {
    if (labelIds.has(asUser)) return labelIds.get(asUser)!
    try {
      const res = (await gmailGet("/labels", {}, asUser)) as { labels?: Array<{ id: string; name: string }> }
      const id = (res.labels ?? []).find((l) => l.name === SNOOZE_LABEL_NAME)?.id ?? null
      if (id) labelIds.set(asUser, id)
      return id
    } catch {
      return null
    }
  }

  let woke = 0
  let cancelled = 0
  // One poisoned row must never starve the rest (per-row settle).
  const results = await Promise.allSettled(
    due.map(async (row) => {
      const asUser = resolveMailbox(row.mailbox)

      let threadFound = true
      let messages: Array<{ id?: string; labelIds?: string[] }> = []
      try {
        const thread = (await gmailGet(`/threads/${row.thread_id}`, { format: "minimal" }, asUser)) as {
          messages?: Array<{ id?: string; labelIds?: string[] }>
        }
        messages = thread.messages ?? []
      } catch (err) {
        // A 404 means the thread is gone — that row is DONE, not retryable.
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
          threadFound = false
        } else {
          throw err // transient (429/5xx): keep the row, retry next run
        }
      }

      const decision = decideWakeAction({
        threadFound,
        messages,
        snoozedLastMessageId: row.snoozed_last_message_id,
      })

      const label = threadFound ? await snoozeLabelFor(asUser) : null

      if (decision.kind === "wake") {
        // UNREAD on wake is deliberate: a thread whose newest message is days
        // old would otherwise return buried and read — invisible on the phone
        // PWA, which defeats the whole point of snoozing it.
        await gmailPost(`/threads/${row.thread_id}/modify`, {
          addLabelIds: ["INBOX", "UNREAD"],
          removeLabelIds: label ? [label] : [],
        }, asUser)
        woke++
      } else if (decision.reason !== "gone" && label) {
        // Cancelled but the thread still exists: just take the label off.
        // Best-effort — the row delete below is what retires the snooze.
        try {
          await gmailPost(`/threads/${row.thread_id}/modify`, { removeLabelIds: [label] }, asUser)
        } catch {
          /* label cleanup is cosmetic; never block retiring the row */
        }
        cancelled++
      } else {
        cancelled++
      }

      // Conditional: only retire the row if it still has the due time we
      // acted on — a re-snooze that landed mid-run survives.
      await db
        .from("email_snoozes")
        .delete()
        .eq("id", row.id)
        .lte("snooze_until", nowIso)
    })
  )

  const failed = results.filter((r) => r.status === "rejected").length
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn(`[email-unsnooze] row ${due[i].id} (${due[i].thread_id}) failed`, r.reason)
    }
  })
  return NextResponse.json({ woke, cancelled, failed, total: due.length })
}
