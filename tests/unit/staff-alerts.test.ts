/**
 * Staff Alerts — read-side feed computed from notes/replies + this person's own dismissals.
 * No content is stored anywhere for this feature; these tests pin the derivation rules.
 */
import { describe, it, expect } from "vitest"
import { computeNoteAlerts, noteUrgencyColors, type NoteAlertSourceNote, type DismissalRow } from "@/lib/notes/staff-alerts"

const ANTONIO = "11111111-1111-4111-8111-111111111111"
const LUCA = "22222222-2222-4222-8222-222222222222"
const OTHER = "33333333-3333-4333-8333-333333333333"
const NOW = new Date("2026-09-04T12:00:00.000Z")

function baseNote(overrides: Partial<NoteAlertSourceNote> = {}): NoteAlertSourceNote {
  return {
    id: "note-1",
    body: "check on the Smit filing",
    author_user_id: ANTONIO,
    author_name: "Antonio",
    visibility: "shared",
    shared_with_user_id: LUCA,
    created_at: "2026-09-01T09:00:00.000Z",
    updated_at: "2026-09-01T09:00:00.000Z",
    staff_note_replies: [],
    staff_note_state: [],
    ...overrides,
  }
}

describe("computeNoteAlerts — note_reply", () => {
  it("shows a reply from someone else", () => {
    const note = baseNote({
      staff_note_replies: [
        { id: "r1", author_user_id: LUCA, author_name: "Luca", body: "on it", created_at: "2026-09-02T10:00:00.000Z" },
      ],
    })
    const alerts = computeNoteAlerts([note], [], ANTONIO, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("note_reply")
    expect(alerts[0].title).toBe("Luca replied to a note")
  })

  it("never alerts the replier about their own reply (a separate note_update fires for the fresh share itself — not what this test checks)", () => {
    const note = baseNote({
      staff_note_replies: [
        { id: "r1", author_user_id: LUCA, author_name: "Luca", body: "on it", created_at: "2026-09-02T10:00:00.000Z" },
      ],
    })
    const replyAlerts = computeNoteAlerts([note], [], LUCA, NOW).filter((a) => a.kind === "note_reply")
    expect(replyAlerts).toHaveLength(0)
  })

  it("never alerts a note's own author about their own note existing", () => {
    // Antonio authored this note; even with no replies it must not alert him.
    const note = baseNote()
    expect(computeNoteAlerts([note], [], ANTONIO, NOW)).toHaveLength(0)
  })

  it("a dismissed reply is excluded; a later reply on the same note still shows", () => {
    const note = baseNote({
      staff_note_replies: [
        { id: "r1", author_user_id: LUCA, author_name: "Luca", body: "first", created_at: "2026-09-02T10:00:00.000Z" },
        { id: "r2", author_user_id: LUCA, author_name: "Luca", body: "second", created_at: "2026-09-03T10:00:00.000Z" },
      ],
    })
    const dismissals: DismissalRow[] = [{ note_id: "note-1", reply_id: "r1", kind: "note_reply", dismissed_at: "2026-09-02T11:00:00.000Z" }]
    const alerts = computeNoteAlerts([note], dismissals, ANTONIO, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].reply_id).toBe("r2")
  })

  it("a private note never alerts anyone but the author, even with a reply row", () => {
    const note = baseNote({
      visibility: "private",
      shared_with_user_id: null,
      staff_note_replies: [
        { id: "r1", author_user_id: LUCA, author_name: "Luca", body: "shouldn't be visible", created_at: "2026-09-02T10:00:00.000Z" },
      ],
    })
    expect(computeNoteAlerts([note], [], OTHER, NOW)).toHaveLength(0)
  })

  it("a team note's reply alerts every viewer who didn't write it — INCLUDING the note's own author", () => {
    const note = baseNote({
      visibility: "team",
      shared_with_user_id: null,
      staff_note_replies: [
        { id: "r1", author_user_id: LUCA, author_name: "Luca", body: "reply", created_at: "2026-09-02T10:00:00.000Z" },
      ],
    })
    expect(computeNoteAlerts([note], [], OTHER, NOW).filter((a) => a.kind === "note_reply")).toHaveLength(1)
    // Antonio authored this note — he still hears about Luca's reply to it, the main
    // case this feature exists for. Only the replier is excluded from their own reply.
    expect(computeNoteAlerts([note], [], ANTONIO, NOW)).toHaveLength(1)
    // Luca is excluded from his OWN reply, but he's still a team-note viewer who isn't the
    // author, so the fresh-share note_update fires for him too (his reply doesn't cancel it).
    const lucaAlerts = computeNoteAlerts([note], [], LUCA, NOW)
    expect(lucaAlerts.filter((a) => a.kind === "note_reply")).toHaveLength(0)
    expect(lucaAlerts.filter((a) => a.kind === "note_update")).toHaveLength(1)
  })

  it("suppresses a reply alert while the note is snoozed for this viewer — matches replyNotifyTargets", () => {
    const note = baseNote({
      staff_note_state: [{ user_id: ANTONIO, archived_at: null, snoozed_until: "2026-12-01T00:00:00.000Z", parked_at: null }],
      staff_note_replies: [
        { id: "r1", author_user_id: LUCA, author_name: "Luca", body: "on it", created_at: "2026-09-02T10:00:00.000Z" },
      ],
    })
    expect(computeNoteAlerts([note], [], ANTONIO, NOW)).toHaveLength(0)
  })
})

describe("computeNoteAlerts — note_update", () => {
  it("fires, worded as an edit, when the note changed after it was created", () => {
    const note = baseNote({ updated_at: "2026-09-02T10:00:00.000Z" })
    const alerts = computeNoteAlerts([note], [], LUCA, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("note_update")
    expect(alerts[0].title).toContain("updated a note")
  })

  it("FIRES, worded as a share, on a brand-new note shared at creation and never touched since — " +
     "the exact bug found live in production: 'I sent a note to Luca and he didn't receive anything' " +
     "(a fresh share has updated_at === created_at, which the original gate wrongly excluded)", () => {
    const note = baseNote() // updated_at === created_at — shared at birth, never edited
    const alerts = computeNoteAlerts([note], [], LUCA, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("note_update")
    expect(alerts[0].title).toContain("shared a note")
  })

  it("a dismissal hides it; a LATER change resurfaces it (timestamp-compared, not existence)", () => {
    const note = baseNote({ updated_at: "2026-09-02T10:00:00.000Z" })
    const dismissedBefore: DismissalRow[] = [{ note_id: "note-1", reply_id: null, kind: "note_update", dismissed_at: "2026-09-02T11:00:00.000Z" }]
    expect(computeNoteAlerts([note], dismissedBefore, LUCA, NOW)).toHaveLength(0)

    const editedAgain = baseNote({ updated_at: "2026-09-03T10:00:00.000Z" })
    expect(computeNoteAlerts([editedAgain], dismissedBefore, LUCA, NOW)).toHaveLength(1)
  })

  it("is NOT suppressed by snooze — editNotifyTargets never checked snooze either, carried over on purpose", () => {
    const note = baseNote({
      updated_at: "2026-09-02T10:00:00.000Z",
      staff_note_state: [{ user_id: LUCA, archived_at: null, snoozed_until: "2026-12-01T00:00:00.000Z", parked_at: null }],
    })
    expect(computeNoteAlerts([note], [], LUCA, NOW)).toHaveLength(1)
  })
})

describe("computeNoteAlerts — ordering and shape", () => {
  it("sorts newest first across mixed notes and kinds", () => {
    const older = baseNote({
      id: "note-old",
      // == created_at, so its OWN note_update alert carries the note's original share
      // timestamp — oldest of the three; the reply on it carries a separately later timestamp.
      updated_at: "2026-09-01T09:00:00.000Z",
      staff_note_replies: [
        { id: "r-old", author_user_id: OTHER, author_name: "Someone Else", body: "old", created_at: "2026-09-02T08:00:00.000Z" },
      ],
    })
    const newer = baseNote({
      id: "note-new",
      updated_at: "2026-09-03T08:00:00.000Z",
    })
    const alerts = computeNoteAlerts([older, newer], [], LUCA, NOW)
    // 3 alerts total: note-new's update, note-old's reply, note-old's own (fresh-share) update —
    // in that chronological order (2026-09-03 > 2026-09-02 > 2026-09-01).
    expect(alerts.map((a) => `${a.note_id}:${a.kind}`)).toEqual([
      "note-new:note_update",
      "note-old:note_reply",
      "note-old:note_update",
    ])
  })

  it("carries a client name through from the nested account/contact select", () => {
    const note = baseNote({ accounts: { company_name: "Aumianna LLC" }, updated_at: "2026-09-02T10:00:00.000Z" })
    expect(computeNoteAlerts([note], [], LUCA, NOW)[0].client_name).toBe("Aumianna LLC")
  })
})

describe("computeNoteAlerts — note_snooze_due", () => {
  it("fires for the person who snoozed it, once their own snooze has elapsed", () => {
    const note = baseNote({
      staff_note_state: [{ user_id: ANTONIO, archived_at: null, snoozed_until: "2026-09-04T10:00:00.000Z", parked_at: null }],
    })
    const alerts = computeNoteAlerts([note], [], ANTONIO, NOW) // NOW = 2026-09-04T12:00 — past the 10:00 snooze
    expect(alerts.filter((a) => a.kind === "note_snooze_due")).toHaveLength(1)
  })

  it("does NOT exclude the note's own author — the opposite of note_reply/note_update, deliberately: " +
     "a snooze is self-triggered, so the actor IS the intended recipient (a council review caught that " +
     "copying the author-exclusion convention here would silently never fire on a private, self-snoozed " +
     "note — the single most common real case)", () => {
    const note = baseNote({
      visibility: "private",
      shared_with_user_id: null,
      author_user_id: ANTONIO,
      staff_note_state: [{ user_id: ANTONIO, archived_at: null, snoozed_until: "2026-09-04T10:00:00.000Z", parked_at: null }],
    })
    const alerts = computeNoteAlerts([note], [], ANTONIO, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("note_snooze_due")
  })

  it("does not fire while the snooze is still in the future", () => {
    const note = baseNote({
      staff_note_state: [{ user_id: ANTONIO, archived_at: null, snoozed_until: "2026-12-01T00:00:00.000Z", parked_at: null }],
    })
    expect(computeNoteAlerts([note], [], ANTONIO, NOW).filter((a) => a.kind === "note_snooze_due")).toHaveLength(0)
  })

  it("does not fire for someone who never snoozed it themselves", () => {
    const note = baseNote({
      staff_note_state: [{ user_id: LUCA, archived_at: null, snoozed_until: "2026-09-04T10:00:00.000Z", parked_at: null }],
    })
    expect(computeNoteAlerts([note], [], ANTONIO, NOW).filter((a) => a.kind === "note_snooze_due")).toHaveLength(0)
  })

  it("a dismissal hides it; a LATER re-snooze that also elapses resurfaces it (timestamp-compared, " +
     "same shape as note_update — never a plain existence check)", () => {
    const note = baseNote({
      staff_note_state: [{ user_id: ANTONIO, archived_at: null, snoozed_until: "2026-09-04T10:00:00.000Z", parked_at: null }],
    })
    const dismissedAfterFirstDue: DismissalRow[] = [
      { note_id: "note-1", reply_id: null, kind: "note_snooze_due", dismissed_at: "2026-09-04T10:30:00.000Z" },
    ]
    expect(computeNoteAlerts([note], dismissedAfterFirstDue, ANTONIO, NOW).filter((a) => a.kind === "note_snooze_due")).toHaveLength(0)

    const reSnoozed = baseNote({
      staff_note_state: [{ user_id: ANTONIO, archived_at: null, snoozed_until: "2026-09-04T11:00:00.000Z", parked_at: null }],
    })
    expect(computeNoteAlerts([reSnoozed], dismissedAfterFirstDue, ANTONIO, NOW).filter((a) => a.kind === "note_snooze_due")).toHaveLength(1)
  })

  it("does not collide with a separate, undismissed note_update dismissal slot on the same note " +
     "(the exact bug a shared dismissal row would have caused, per the 2026-09-09 migration)", () => {
    const note = baseNote({
      updated_at: "2026-09-04T09:00:00.000Z", // fires note_update for a non-author viewer
      staff_note_state: [{ user_id: LUCA, archived_at: null, snoozed_until: "2026-09-04T10:00:00.000Z", parked_at: null }],
    })
    const dismissedDueOnly: DismissalRow[] = [
      { note_id: "note-1", reply_id: null, kind: "note_snooze_due", dismissed_at: "2026-09-04T10:30:00.000Z" },
    ]
    const alerts = computeNoteAlerts([note], dismissedDueOnly, LUCA, NOW)
    // note_snooze_due dismissed and gone, but note_update — a different kind, different slot — still fires.
    expect(alerts.map((a) => a.kind)).toEqual(["note_update"])
  })
})

describe("noteUrgencyColors", () => {
  it("maps a note_reply or note_update alert to red", () => {
    const colors = noteUrgencyColors([{ kind: "note_update", note_id: "n1" }])
    expect(colors.get("n1")).toBe("red")
  })

  it("maps a note_snooze_due alert, alone, to teal", () => {
    const colors = noteUrgencyColors([{ kind: "note_snooze_due", note_id: "n1" }])
    expect(colors.get("n1")).toBe("teal")
  })

  it("red wins when a note has both a reply/update alert AND a snooze-due alert — regardless of " +
     "which order they appear in the alerts list", () => {
    const redFirst = noteUrgencyColors([
      { kind: "note_update", note_id: "n1" },
      { kind: "note_snooze_due", note_id: "n1" },
    ])
    expect(redFirst.get("n1")).toBe("red")

    const tealFirst = noteUrgencyColors([
      { kind: "note_snooze_due", note_id: "n1" },
      { kind: "note_reply", note_id: "n1" },
    ])
    expect(tealFirst.get("n1")).toBe("red")
  })

  it("a note with no alerts at all has no entry in the map", () => {
    expect(noteUrgencyColors([]).has("n1")).toBe(false)
  })
})
