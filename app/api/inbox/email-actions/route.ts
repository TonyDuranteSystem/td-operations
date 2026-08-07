import { NextRequest, NextResponse } from "next/server"
import { gmailGet, gmailPost, getHeader, extractBody, type GmailAPIMessage } from "@/lib/gmail"
import { COLOR_MARKS, MARK_LABEL_PREFIX } from "@/lib/inbox/color-marks"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { SNOOZE_LABEL_NAME, isValidSnoozeUntil } from "@/lib/inbox/email-snooze"
import { resolveMailbox } from "@/lib/inbox/mailbox"
import { allSettledBounded } from "@/lib/inbox/bounded-settled"
import { reindexThreadsAfterAction } from "@/lib/email-index/sync"
import {
  captureRestorableLabels,
  sanitizeRestorePayload,
  type RestoreEntry,
} from "@/lib/inbox/trash-restore"

export const dynamic = "force-dynamic"

type EmailAction = "archive" | "star" | "unstar" | "trash" | "untrash" | "delete_forever" | "forward" | "mark_read" | "mark_unread" | "move_to_label" | "set_color" | "snooze" | "unsnooze"


/**
 * Per-mailbox id of the "Snoozed" user label, created if absent. On a create
 * failure (e.g. a concurrent create 409ing), the list is re-fetched before
 * giving up — the label usually exists by then.
 */
async function getSnoozeLabelId(asUser: string): Promise<string> {
  const list = async () => {
    const res = (await gmailGet("/labels", {}, asUser)) as { labels?: Array<{ id: string; name: string }> }
    return (res.labels ?? []).find((l) => l.name === SNOOZE_LABEL_NAME)?.id
  }
  const existing = await list()
  if (existing) return existing
  try {
    const created = (await gmailPost("/labels", {
      name: SNOOZE_LABEL_NAME,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }, asUser)) as { id: string }
    return created.id
  } catch (err) {
    const retry = await list()
    if (retry) return retry
    throw err
  }
}

/** Gmail message/thread/label ids are opaque hex-ish tokens. Anything else is
 *  rejected before it can reach a URL path — see the gate in POST(). */
const GMAIL_ID = /^[A-Za-z0-9_-]{1,128}$/

type MinimalThread = { messages?: Array<{ id?: string; labelIds?: string[] }> }

/**
 * Snapshot UNREAD/STARRED/IMPORTANT before trashing, so an Undo can put them
 * back — trashing strips them and Gmail cannot tell us what they were after the
 * fact. Best-effort: a failed read must never block the delete itself.
 */
async function snapshotBeforeTrash(threadId: string, asUser: string): Promise<RestoreEntry[]> {
  try {
    const thread = (await gmailGet(`/threads/${threadId}`, { format: 'minimal' }, asUser)) as MinimalThread
    return captureRestorableLabels(thread.messages)
  } catch {
    return []
  }
}

/**
 * Our own stored copy's side of a delete/restore (dev_task 01800da8).
 *
 * Deleting only moved the email to Gmail's Trash; our copy of the body and
 * attachments is separate and would otherwise sit there forever. Stamping it
 * starts the 180-day bin clock — the copy is KEPT and readable the whole time
 * (Gmail drops its own Trash at ~30 days, so past that ours is the only copy),
 * then the daily purge sweep removes it for real.
 *
 * Best-effort by design: the Gmail action is what the user sees, so a failure
 * here must never fail their delete, and it is only an OPTIMISATION: the bin
 * state is reconciled from Gmail's own labels by `reconcileBinState()` on the
 * index-sync cron, so a missed stamp is corrected within minutes. Never a lost
 * email.
 */
async function binOurCopy(
  mailbox: string,
  threadIds: string[],
  mode: "delete" | "restore",
) {
  try {
    const box = mailbox === "antonio" ? "antonio" : "support"
    const { markDeleted, markRestored } = await import("@/lib/email-store/deletion")
    const sel = { threadIds }
    if (mode === "delete") await markDeleted(box, sel)
    else await markRestored(box, sel)
  } catch (err) {
    console.warn(`[inbox] could not ${mode} our stored copy of ${threadIds.length} thread(s):`, err)
  }
}

/** Audit trail for a permanent erase — the rows it destroys are the only other
 *  record that the email ever existed. Best-effort: never fail the erase itself. */
async function logPermanentErase(
  mailbox: string,
  threadId: string,
  messageIds: string[],
  errors: number,
) {
  try {
    const { createClient } = await import("@/lib/supabase/server")
    const { data: { user } } = await createClient().auth.getUser()
    await supabaseAdmin.from("action_log").insert({
      action: "email_delete_forever",
      entity_type: "email",
      entity_id: threadId,
      details: {
        mailbox,
        thread_id: threadId,
        message_ids: messageIds,
        message_count: messageIds.length,
        errors,
        actor: user?.email ?? "unknown",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  } catch (err) {
    console.error("[delete_forever] audit log failed", err)
  }
}

/**
 * Undo of a trash: untrash every message, put the thread back in INBOX, and
 * re-apply the labels captured at trash time.
 */
async function untrashThread(threadId: string, asUser: string, restore: RestoreEntry[], destLabelId?: string): Promise<{ filedTo: string }> {
  // Gmail doesn't allow removing TRASH via modify — must use /untrash per message
  const trashThread = (await gmailGet(`/threads/${threadId}`, { format: 'minimal' }, asUser)) as {
    messages: Array<{ id: string }>
  }
  await Promise.all(
    trashThread.messages.map((m) => gmailPost(`/messages/${m.id}/untrash`, {}, asUser))
  )
  // Default: back to the INBOX. Note trashing never strips a custom folder label
  // (it removes only INBOX/UNREAD/STARRED/IMPORTANT), so a restored email keeps
  // its folders for free — "put it back where it was" needs no snapshot.
  //
  // With a destination, the email goes THERE instead of the Inbox: add that
  // label and drop INBOX. Always-INBOX is the deliberate fallback — it is the one
  // list the user is certain to look in, so a restore can never land somewhere
  // invisible.
  // ── The email is now in NO list: the untrash above stripped TRASH and nothing
  // has been added yet. Every failure from here must leave it somewhere the user
  // can SEE it — never "reachable only by search".
  //
  // Ladder: the requested destination → the Inbox → put it back in Trash. The
  // Inbox rung matters most: it is the one this ships with (nothing sends a
  // destination yet), and the first version guarded only the destination branch —
  // i.e. only the path no client could reach (bug-hunter, twice).
  let filedTo = destLabelId ?? "INBOX"
  const file = (params: Record<string, string[]>) => gmailPost(`/threads/${threadId}/modify`, params, asUser)
  try {
    await file(
      destLabelId
        ? { addLabelIds: [destLabelId], removeLabelIds: ["INBOX"] }
        : { addLabelIds: ["INBOX"] }
    )
  } catch (err) {
    console.warn(`[untrash] filing ${threadId} into ${filedTo} failed`, err)
    try {
      // Rung 2 — the Inbox. (If the destination WAS the Inbox this is a retry,
      // which is exactly right for the rate-limit case that dominates here.)
      await file({ addLabelIds: ["INBOX"] })
      filedTo = "INBOX"
    } catch (err2) {
      // Rung 3 — undo our own untrash so the state stays HONEST: the email goes
      // back to Trash, exactly where the user last saw it, and the error we throw
      // is then true ("restore failed") instead of a lie over a vanished email.
      console.error(`[untrash] INBOX fallback for ${threadId} failed; re-trashing to avoid stranding`, err2)
      try {
        await file({ addLabelIds: ["TRASH"] })
      } catch (err3) {
        console.error(`[untrash] re-trash of ${threadId} FAILED — thread is in no list`, err3)
      }
      throw err2
    }
  }

  // Restore the read/starred/important state the trash stripped.
  if (restore.length > 0) {
    await Promise.all(
      restore.map((e) =>
        gmailPost(`/messages/${e.id}/modify`, { addLabelIds: e.labels }, asUser)
      )
    )
  }
  return { filedTo }
}

export async function POST(req: NextRequest) {
  try {
    // Staff only. /api/* inherits just "is logged in" from middleware, and a
    // portal CLIENT has a login — without this line a client could archive,
    // trash or snooze support@ mail (the 2026-07-21 templates-route invariant:
    // every staff API route carries its own gate; council review 2026-07-28).
    const denied = await requireStaffRoute()
    if (denied) return denied

    const body = await req.json()
    const { threadId, threadIds, action, forwardTo, labelId, bulk, mailbox, color, restore, destLabelId, snoozeUntil } = body as {
      threadId?: string
      threadIds?: string[]
      action: EmailAction | 'mark_read'
      forwardTo?: string
      labelId?: string
      bulk?: boolean
      mailbox?: string
      /** set_color: mark key ('red' | …) or null to clear */
      color?: string | null
      /** untrash: the read/starred/important state captured when the thread was
       *  trashed, round-tripped by the browser. Single: RestoreEntry[]. Bulk: a
       *  map keyed by threadId. Sanitized before use — never trusted. */
      restore?: unknown
      /** untrash: restore INTO this label instead of the Inbox (a Gmail label id).
       *  Omit for the default "back where it was + Inbox". */
      destLabelId?: string
      /** snooze: ISO instant (with offset) when the email should return. */
      snoozeUntil?: string
    }

    if (!(await checkMailboxAccess(mailbox))) {
      return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
    }

    // Every id in this request is interpolated into a Gmail API path. `new URL()`
    // NORMALISES dot-segments, so an id like "../messages?maxResults=500" turns
    // threads.get into messages.list — and whatever that returns then feeds the
    // per-message loops below. Fail closed on anything that is not a Gmail id.
    // (Security review, 2026-08-04. Gmail ids are opaque hex-ish tokens.)
    const badId = [threadId, ...(threadIds ?? []), labelId, destLabelId]
      .filter((v): v is string => typeof v === "string")
      .find((v) => !GMAIL_ID.test(v))
    if (badId !== undefined) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 })
    }

    const asUser = resolveMailbox(mailbox)
    /** Key for our own email index ('support' | 'antonio'). Every label
     *  mutation below re-indexes its thread(s) through this key so the
     *  index-served list reflects the action immediately (write-through via
     *  the one writer — council 2026-08-07). */
    const mailboxKey: "support" | "antonio" = mailbox === "antonio" ? "antonio" : "support"

    // Bulk operations
    if (bulk && threadIds?.length) {
      // Bulk trash: snapshot each thread's restorable labels so the bulk Undo can
      // put them back (keyed by threadId and handed to the browser).
      const bulkRestore: Record<string, RestoreEntry[]> = {}
      // Bulk untrash (the Undo of a bulk delete): the browser hands the snapshot back.
      const bulkRestoreIn = (restore && typeof restore === 'object' && !Array.isArray(restore))
        ? (restore as Record<string, unknown>)
        : {}

      // BOUNDED fan-out (council blocker, 2026-08-07): a select-all archive of a
      // full page used to fire one simultaneous Gmail call per thread — the
      // 2026-08-02 self-rate-limit incident's exact shape, rebuilt behind a new
      // button. Ceiling matches the conversations route's cap.
      const results = await allSettledBounded(threadIds, 10, async (tid) => {
          if (action === 'trash') {
            bulkRestore[tid] = await snapshotBeforeTrash(tid, asUser)
            await gmailPost(`/threads/${tid}/modify`, {
              addLabelIds: ["TRASH"],
              removeLabelIds: ["INBOX", "UNREAD", "STARRED", "IMPORTANT"]
            }, asUser)
            await binOurCopy(mailbox, [tid], "delete")
          } else if (action === 'untrash') {
            await untrashThread(tid, asUser, sanitizeRestorePayload(bulkRestoreIn[tid]))
            await binOurCopy(mailbox, [tid], "restore")
          } else if (action === 'archive') {
            await gmailPost(`/threads/${tid}/modify`, { removeLabelIds: ['INBOX'] }, asUser)
          } else if (action === 'mark_read') {
            const thread = (await gmailGet(`/threads/${tid}`, { format: 'minimal' }, asUser)) as { messages: Array<{ id: string }> }
            await Promise.all(
              thread.messages.map((m) =>
                gmailPost(`/messages/${m.id}/modify`, { removeLabelIds: ['UNREAD'] }, asUser)
              )
            )
          } else if (action === 'mark_unread') {
            // threads.modify applies to every message in the thread
            await gmailPost(`/threads/${tid}/modify`, { addLabelIds: ['UNREAD'] }, asUser)
          } else if (action === 'move_to_label' && labelId) {
            await gmailPost(`/threads/${tid}/modify`, { addLabelIds: [labelId] }, asUser)
          } else {
            // An unmatched action used to fulfil and count as "succeeded" —
            // a bulk snooze wired only into the single-thread switch would
            // have reported success while doing nothing (council 2026-07-28).
            throw new Error(`Unsupported bulk action: ${action}`)
          }
      })
      const succeeded = results.filter(r => r.status === 'fulfilled').length
      const failed = results.filter(r => r.status === 'rejected').length
      // WHICH ones failed, not just how many. `allSettled` knows the identity and
      // we were throwing it away, so the client could only guess — it dropped the
      // whole batch's optimistic hides on any failure (crude but safe), and on the
      // UNDO path it dropped none, hiding the still-trashed emails from Trash: the
      // one place its own toast told the user to look (senior engineer, 2026-07-16).
      const failedIds = threadIds.filter((_, i) => results[i].status === 'rejected')
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.warn(`[bulk ${action}] ${threadIds[i]} failed`, r.reason)
      })
      // Write-through: refresh our index for the threads Gmail ACTUALLY changed
      // — never the refused ones (re-indexing a failed archive as archived would
      // falsify the row with no push event to ever correct it).
      const fulfilledIds = threadIds.filter((_, i) => results[i].status === 'fulfilled')
      await reindexThreadsAfterAction(mailboxKey, fulfilledIds)
      return NextResponse.json({
        success: true,
        action,
        succeeded,
        failed,
        failedIds,
        total: threadIds.length,
        ...(action === 'trash' ? { restore: bulkRestore } : {}),
      })
    }

    if (!threadId || !action) {
      return NextResponse.json(
        { error: "threadId and action are required" },
        { status: 400 }
      )
    }

    switch (action) {
      case "archive": {
        await gmailPost(`/threads/${threadId}/modify`, { removeLabelIds: ["INBOX"] }, asUser)
        await reindexThreadsAfterAction(mailboxKey, [threadId])
        return NextResponse.json({ success: true, action: "archived" })
      }

      case "star": {
        const thread = (await gmailGet(`/threads/${threadId}`, { format: "minimal" }, asUser)) as { messages: Array<{ id: string }> }
        await Promise.all(
          thread.messages.map((m) =>
            gmailPost(`/messages/${m.id}/modify`, { addLabelIds: ["STARRED"] }, asUser)
          )
        )
        await reindexThreadsAfterAction(mailboxKey, [threadId])
        return NextResponse.json({ success: true, action: "starred" })
      }

      case "unstar": {
        const thread = (await gmailGet(`/threads/${threadId}`, { format: "minimal" }, asUser)) as { messages: Array<{ id: string }> }
        await Promise.all(
          thread.messages.map((m) =>
            gmailPost(`/messages/${m.id}/modify`, { removeLabelIds: ["STARRED"] }, asUser)
          )
        )
        await reindexThreadsAfterAction(mailboxKey, [threadId])
        return NextResponse.json({ success: true, action: "unstarred" })
      }

      case "trash": {
        // Step 0: snapshot UNREAD/STARRED/IMPORTANT BEFORE we strip them, so the
        // Undo can restore the email exactly as it was (2026-07-14).
        const restoreSnapshot = await snapshotBeforeTrash(threadId, asUser)

        // Use modify instead of /trash endpoint — /trash is unreliable with Service Account DWD
        // Step 1: Remove from INBOX + add TRASH label via modify
        const modifyResult = await gmailPost(`/threads/${threadId}/modify`, {
          addLabelIds: ["TRASH"],
          removeLabelIds: ["INBOX", "UNREAD", "STARRED", "IMPORTANT"]
        }, asUser) as { id?: string }

        // Our copy joins the bin (Gmail side is done; ours is a separate store).
        await binOurCopy(mailbox, [threadId], "delete")
        await reindexThreadsAfterAction(mailboxKey, [threadId])

        // Step 2: Verify by fetching the thread and checking labels
        let verified = false
        try {
          const verifyThread = await gmailGet(`/threads/${threadId}`, { format: 'minimal' }, asUser) as {
            messages?: Array<{ labelIds?: string[] }>
          }
          const hasTrash = verifyThread.messages?.some(m => m.labelIds?.includes('TRASH'))
          const hasInbox = verifyThread.messages?.some(m => m.labelIds?.includes('INBOX'))
          verified = !!hasTrash && !hasInbox
          console.warn(`[Inbox] Trash thread ${threadId}: TRASH=${hasTrash}, INBOX=${hasInbox}, verified=${verified}`)
        } catch {
          // Thread might not be accessible after trash — that's OK
          verified = true
        }

        return NextResponse.json({
          success: true,
          action: "trashed",
          threadId: modifyResult.id,
          verified,
          restore: restoreSnapshot,
        })
      }

      case "untrash": {
        if (destLabelId != null) {
          if (typeof destLabelId !== "string" || !destLabelId) {
            return NextResponse.json({ error: "destLabelId must be a non-empty string" }, { status: 400 })
          }
          // Only a real USER folder. A system list would file the email somewhere
          // the client cannot name: 'TRASH' would untrash-then-re-trash while the
          // UI hid it from Trash, and the pin would sit at a view key that
          // `toInboxView` never produces, so it would apply nowhere.
          const labelsRes = (await gmailGet("/labels", {}, asUser)) as {
            labels?: Array<{ id: string; type?: string }>
          }
          const dest = (labelsRes.labels ?? []).find((l) => l.id === destLabelId)
          if (!dest || dest.type !== "user") {
            return NextResponse.json(
              { error: "Restore destination must be one of your folders." },
              { status: 400 }
            )
          }
        }
        const filed = await untrashThread(threadId, asUser, sanitizeRestorePayload(restore), destLabelId)
        await binOurCopy(mailbox, [threadId], "restore")
        await reindexThreadsAfterAction(mailboxKey, [threadId])
        // Report where it ACTUALLY landed — not where we were asked to put it.
        return NextResponse.json({ success: true, action: "untrashed", filedTo: filed.filedTo })
      }

      case "delete_forever": {
        // "Delete forever" = ERASE OUR STORED COPY, NOW. For junk and
        // advertising Antonio does not want us holding at all (2026-08-02).
        //
        // It deliberately does NOT hard-delete in Gmail. Our Google grant is
        // `gmail.modify`, which is documented as "all read/write EXCEPT
        // immediate permanent deletion" — users.messages.delete needs the full
        // https://mail.google.com/ scope, which TD has not granted. The first
        // version of this called it anyway: every click would have 403'd AFTER
        // flagging our copy for destruction, so the email survived in Gmail and
        // only our copy died (senior-engineer, 2026-08-04). Gmail empties its own
        // Trash at ~30 days, so leaving it there erases it on Google's side too.
        //
        // PER MESSAGE, NEVER PER THREAD. A trashed thread routinely picks up a
        // LIVE reply later; thread-scoped erasure would have destroyed that
        // reply's only stored copy (bug-hunter, 2026-08-04). Only messages
        // actually carrying TRASH are touched, checked HERE on the server — the
        // UI showing the button only inside Trash is not a boundary.
        const thread = (await gmailGet(`/threads/${threadId}`, { format: "minimal" }, asUser)) as MinimalThread
        const trashed = (thread.messages ?? [])
          .filter((m) => m?.id && (m.labelIds ?? []).includes("TRASH"))
          .map((m) => m.id as string)

        if (trashed.length === 0) {
          return NextResponse.json(
            { error: "This email is not in the Trash. Delete it first, then erase it." },
            { status: 400 },
          )
        }

        const box = mailbox === "antonio" ? "antonio" : "support"
        const { purgeMessagesNow } = await import("@/lib/email-store/deletion")
        const tally = await purgeMessagesNow(box, trashed)

        // Permanent destruction of client correspondence leaves a record of who
        // did it — the rows themselves are gone, so this is the only trace.
        await logPermanentErase(box, threadId, trashed, tally.errors)

        if (tally.errors > 0 && tally.purged === 0) {
          return NextResponse.json(
            { error: "Could not erase our copy — nothing was deleted. Please try again." },
            { status: 500 },
          )
        }
        return NextResponse.json({
          success: true,
          action: "deleted_forever",
          messages: tally.purged,
          objectsRemoved: tally.objectsRemoved,
          partial: tally.errors > 0,
        })
      }

      case "mark_read": {
        // The single-email path never had this case, so the "Mark read" button
        // inside an open email returned "Unknown action: mark_read" (Antonio
        // 2026-08-02) — only the BULK branch handled it. Mirrors mark_unread.
        const thread = (await gmailGet(`/threads/${threadId}`, { format: "minimal" }, asUser)) as { messages: Array<{ id: string }> }
        await Promise.all(
          thread.messages.map((m) =>
            gmailPost(`/messages/${m.id}/modify`, { removeLabelIds: ["UNREAD"] }, asUser)
          )
        )
        await reindexThreadsAfterAction(mailboxKey, [threadId])
        return NextResponse.json({ success: true, action: "marked_read" })
      }

      case "mark_unread": {
        const thread = (await gmailGet(`/threads/${threadId}`, { format: "minimal" }, asUser)) as { messages: Array<{ id: string }> }
        await Promise.all(
          thread.messages.map((m) =>
            gmailPost(`/messages/${m.id}/modify`, { addLabelIds: ["UNREAD"] }, asUser)
          )
        )
        await reindexThreadsAfterAction(mailboxKey, [threadId])
        return NextResponse.json({ success: true, action: "marked_unread" })
      }

      case "move_to_label": {
        if (!labelId) {
          return NextResponse.json({ error: "labelId is required" }, { status: 400 })
        }
        await gmailPost(`/threads/${threadId}/modify`, { addLabelIds: [labelId] }, asUser)
        await reindexThreadsAfterAction(mailboxKey, [threadId])
        return NextResponse.json({ success: true, action: "labeled" })
      }

      case "snooze": {
        if (!snoozeUntil || !isValidSnoozeUntil(snoozeUntil, new Date())) {
          return NextResponse.json(
            { error: "Snooze time must be at least a minute in the future." },
            { status: 400 }
          )
        }
        // Newest message id at snooze time — the cron uses it to CANCEL the
        // wake if new mail arrives meanwhile (the reply already re-surfaced
        // the thread; waking later would resurrect a handled conversation).
        const snapshot = (await gmailGet(`/threads/${threadId}`, { format: "minimal" }, asUser)) as MinimalThread
        const lastMessageId = snapshot.messages?.[snapshot.messages.length - 1]?.id ?? null

        // DB row FIRST, Gmail second: a row without the label self-heals (the
        // cron's wake is a no-op on an inboxed thread), while a labeled thread
        // without a row is a client email nothing will ever bring back
        // (council bug-hunter blocker, 2026-07-28).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: upsertErr } = await (supabaseAdmin as any)
          .from("email_snoozes")
          .upsert(
            {
              mailbox: mailbox === "antonio" ? "antonio" : "support",
              thread_id: threadId,
              snooze_until: snoozeUntil,
              snoozed_last_message_id: lastMessageId,
            },
            { onConflict: "mailbox,thread_id" }
          )
        if (upsertErr) {
          return NextResponse.json(
            { error: `Could not save the snooze: ${upsertErr.message}` },
            { status: 500 }
          )
        }
        try {
          const snoozeLabelId = await getSnoozeLabelId(asUser)
          await gmailPost(`/threads/${threadId}/modify`, {
            addLabelIds: [snoozeLabelId],
            removeLabelIds: ["INBOX"],
          }, asUser)
        } catch (err) {
          // Roll the row back so a failed snooze isn't half-armed.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabaseAdmin as any)
            .from("email_snoozes")
            .delete()
            .eq("mailbox", mailbox === "antonio" ? "antonio" : "support")
            .eq("thread_id", threadId)
          const msg = err instanceof Error ? err.message : "Gmail refused the change"
          return NextResponse.json(
            { error: `Could not snooze this email: ${msg}` },
            { status: 502 }
          )
        }
        await reindexThreadsAfterAction(mailboxKey, [threadId])
        return NextResponse.json({ success: true, action: "snoozed", snoozeUntil })
      }

      case "unsnooze": {
        // The Undo of a snooze: back into the Inbox now, label off, row gone.
        // Tolerates a missing row (e.g. a manually-filed "Snoozed" thread).
        const snoozeLabelId = await getSnoozeLabelId(asUser)
        await gmailPost(`/threads/${threadId}/modify`, {
          addLabelIds: ["INBOX"],
          removeLabelIds: [snoozeLabelId],
        }, asUser)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabaseAdmin as any)
          .from("email_snoozes")
          .delete()
          .eq("mailbox", mailbox === "antonio" ? "antonio" : "support")
          .eq("thread_id", threadId)
        await reindexThreadsAfterAction(mailboxKey, [threadId])
        return NextResponse.json({ success: true, action: "unsnoozed" })
      }

      case "set_color": {
        // Marks are Gmail labels named Marked/<Color> — one color per thread.
        if (color && !COLOR_MARKS.some((m) => m.key === color)) {
          return NextResponse.json({ error: `Unknown color: ${color}` }, { status: 400 })
        }

        const labelsRes = (await gmailGet("/labels", {}, asUser)) as {
          labels?: Array<{ id: string; name: string }>
        }
        const markLabels = (labelsRes.labels ?? []).filter((l) =>
          l.name.startsWith(MARK_LABEL_PREFIX)
        )

        let addId: string | undefined
        if (color) {
          const def = COLOR_MARKS.find((m) => m.key === color)!
          const existing = markLabels.find((l) => l.name === def.labelName)
          if (existing) {
            addId = existing.id
          } else {
            // Create the label on first use. Gmail only accepts colors from its
            // fixed palette — fall back to a colorless label if rejected.
            const base = {
              name: def.labelName,
              labelListVisibility: "labelShow",
              messageListVisibility: "show",
            }
            let created: { id: string }
            try {
              created = (await gmailPost("/labels", { ...base, color: def.gmailColor }, asUser)) as { id: string }
            } catch {
              created = (await gmailPost("/labels", base, asUser)) as { id: string }
            }
            addId = created.id
          }
        }

        const removeIds = markLabels.map((l) => l.id).filter((id) => id !== addId)
        await gmailPost(`/threads/${threadId}/modify`, {
          ...(addId ? { addLabelIds: [addId] } : {}),
          ...(removeIds.length > 0 ? { removeLabelIds: removeIds } : {}),
        }, asUser)

        await reindexThreadsAfterAction(mailboxKey, [threadId])
        return NextResponse.json({ success: true, action: "color_set", color: color ?? null })
      }

      case "forward": {
        if (!forwardTo) {
          return NextResponse.json({ error: "forwardTo is required for forward action" }, { status: 400 })
        }

        const fwdThread = (await gmailGet(`/threads/${threadId}`, { format: "full" }, asUser)) as { messages: GmailAPIMessage[] }
        const lastMsg = fwdThread.messages[fwdThread.messages.length - 1]
        const origFrom = getHeader(lastMsg.payload.headers, "From")
        const origSubject = getHeader(lastMsg.payload.headers, "Subject")
        const origDate = getHeader(lastMsg.payload.headers, "Date")
        const origBody = extractBody(lastMsg.payload)

        const fwdBody = [
          `---------- Forwarded message ----------`,
          `From: ${origFrom}`,
          `Date: ${origDate}`,
          `Subject: ${origSubject}`,
          ``,
          origBody.length > 5000 ? origBody.slice(0, 5000) + "..." : origBody,
        ].join("\n")

        const fwdSubject = origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`
        const encodedFwdSubject = `=?utf-8?B?${Buffer.from(fwdSubject).toString("base64")}?=`
        const fromAddr = asUser
        const headers = [
          `From: ${fromAddr}`,
          `To: ${forwardTo}`,
          `Subject: ${encodedFwdSubject}`,
          "Content-Type: text/plain; charset=utf-8",
        ]

        const raw = headers.join("\r\n") + "\r\n\r\n" + fwdBody
        const encodedRaw = Buffer.from(raw).toString("base64url")

        const result = await gmailPost("/messages/send", { raw: encodedRaw }, asUser)
        return NextResponse.json({
          success: true,
          action: "forwarded",
          messageId: (result as { id?: string }).id,
        })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (error) {
    console.error("Email action error:", error)
    return NextResponse.json({ error: "Failed to perform email action" }, { status: 500 })
  }
}
