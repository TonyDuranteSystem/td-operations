/**
 * Staff Alerts — read-side notification feed sourced from sticky notes.
 *
 * DELIBERATELY NOT a write-path table copying note/reply content. Every alert is computed
 * fresh from staff_notes / staff_note_replies (the same data the note editor already reads)
 * using the SAME targeting rules already used for the existing push notifications — this can
 * never drift out of sync with what already pings the phone, because there is nothing to keep
 * in sync. The only new persisted state is staff_alert_state: one row per (person, thing)
 * recording "dismissed, as of when."
 */

import { isNoteVisibleTo, isSnoozedFor, type NoteVisibility, type NoteStateRow } from "./staff-notes"

export type NoteAlertKind = "note_reply" | "note_update"

export interface NoteAlertReply {
  id: string
  author_user_id: string | null
  author_name: string | null
  body: string
  created_at: string
}

/** Shape read from NOTE_COLUMNS — structurally compatible with NoteWithState for the
 *  snooze/visibility predicates it reuses (no separate type import needed). */
export interface NoteAlertSourceNote {
  id: string
  body: string
  author_user_id: string | null
  author_name: string | null
  visibility: NoteVisibility
  shared_with_user_id: string | null
  created_at: string
  updated_at: string
  archived_at?: string | null
  snoozed_until?: string | null
  account_id?: string | null
  contact_id?: string | null
  accounts?: { company_name: string | null } | null
  contacts?: { full_name: string | null } | null
  staff_note_replies?: NoteAlertReply[] | null
  staff_note_state?: NoteStateRow[] | null
}

export interface DismissalRow {
  note_id: string
  reply_id: string | null
  dismissed_at: string
}

export interface NoteAlert {
  kind: NoteAlertKind
  note_id: string
  reply_id: string | null
  author_name: string | null
  title: string
  body: string
  url: string
  tag: string
  client_name: string | null
  created_at: string
}

function clientNameOf(note: NoteAlertSourceNote): string | null {
  return note.accounts?.company_name ?? note.contacts?.full_name ?? null
}

/** Numeric compare — NEVER string-compare ISO timestamps (this codebase has been bitten by
 *  exactly that: 'Z' vs '+00:00' suffixes sort differently than they resolve chronologically). */
function parsedMs(iso: string | null | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

function dismissedAtMsFor(
  dismissals: readonly DismissalRow[],
  noteId: string,
  replyId: string | null,
): number | null {
  const row = dismissals.find((d) => d.note_id === noteId && d.reply_id === replyId)
  return row ? parsedMs(row.dismissed_at) : null
}

/**
 * Staff Alerts feed for ONE person — computed from notes they can see, those notes' replies,
 * and their own dismissals. Two kinds, each mirroring an existing push exactly:
 *
 *  - note_reply: one per reply from someone else, cleared per-reply. Suppressed while the note
 *    is snoozed for this person — same as replyNotifyTargets does for the push.
 *  - note_update: the note was shared with this person or edited since they last dismissed it —
 *    one live alert per note, timestamp-compared so a fresh change after a dismiss reappears.
 *    NOT suppressed by snooze — editNotifyTargets never checked snooze either; carried over on
 *    purpose rather than invented, so this list can never disagree with what already pushed.
 *
 * A note's OWN author never gets an alert from it.
 */
export function computeNoteAlerts(
  notes: readonly NoteAlertSourceNote[],
  dismissals: readonly DismissalRow[],
  userId: string,
  now: Date,
): NoteAlert[] {
  const out: NoteAlert[] = []

  for (const note of notes) {
    if (!isNoteVisibleTo(note, userId)) continue
    const clientName = clientNameOf(note)

    // note_reply: anyone ELSE's reply — including on a note I authored myself, which is
    // the main case this feature exists for ("Luca replied to my note"). Only the REPLIER
    // is excluded when it's me, never the note's author.
    for (const reply of note.staff_note_replies ?? []) {
      if (!reply.author_user_id || reply.author_user_id === userId) continue
      if (isSnoozedFor(note, userId, now)) continue
      if (dismissedAtMsFor(dismissals, note.id, reply.id) != null) continue
      out.push({
        kind: "note_reply",
        note_id: note.id,
        reply_id: reply.id,
        author_name: reply.author_name,
        title: `${reply.author_name || "Someone"} replied to a note`,
        body: reply.body.slice(0, 160),
        url: `/notes?note=${note.id}`,
        tag: `staff-alert-reply-${reply.id}`,
        client_name: clientName,
        created_at: reply.created_at,
      })
    }

    // note_update: only the AUTHOR can edit a note's text or change who sees it
    // (mayEditBody / the visibility guard are both author-only), so an update alert on my
    // own note would only ever be about my own action — skip it for the author entirely.
    if (note.author_user_id !== userId) {
      const updatedMs = parsedMs(note.updated_at)
      if (updatedMs > parsedMs(note.created_at)) {
        const dismissedMs = dismissedAtMsFor(dismissals, note.id, null)
        if (dismissedMs == null || dismissedMs < updatedMs) {
          out.push({
            kind: "note_update",
            note_id: note.id,
            reply_id: null,
            author_name: note.author_name,
            title: `${note.author_name || "Someone"} updated a note`,
            body: note.body.slice(0, 160),
            url: `/notes?note=${note.id}`,
            tag: `staff-alert-update-${note.id}`,
            client_name: clientName,
            created_at: note.updated_at,
          })
        }
      }
    }
  }

  return out.sort((a, b) => parsedMs(b.created_at) - parsedMs(a.created_at))
}
