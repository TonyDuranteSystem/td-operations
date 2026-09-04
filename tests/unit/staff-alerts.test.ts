/**
 * Staff Alerts — read-side feed computed from notes/replies + this person's own dismissals.
 * No content is stored anywhere for this feature; these tests pin the derivation rules.
 */
import { describe, it, expect } from "vitest"
import { computeNoteAlerts, type NoteAlertSourceNote, type DismissalRow } from "@/lib/notes/staff-alerts"

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

  it("never alerts the replier about their own reply", () => {
    const note = baseNote({
      staff_note_replies: [
        { id: "r1", author_user_id: LUCA, author_name: "Luca", body: "on it", created_at: "2026-09-02T10:00:00.000Z" },
      ],
    })
    expect(computeNoteAlerts([note], [], LUCA, NOW)).toHaveLength(0)
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
    const dismissals: DismissalRow[] = [{ note_id: "note-1", reply_id: "r1", dismissed_at: "2026-09-02T11:00:00.000Z" }]
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
    expect(computeNoteAlerts([note], [], OTHER, NOW)).toHaveLength(1)
    // Antonio authored this note — he still hears about Luca's reply to it, the main
    // case this feature exists for. Only the replier is excluded from their own reply.
    expect(computeNoteAlerts([note], [], ANTONIO, NOW)).toHaveLength(1)
    expect(computeNoteAlerts([note], [], LUCA, NOW)).toHaveLength(0)
  })

  it("suppresses a reply alert while the note is snoozed for this viewer — matches replyNotifyTargets", () => {
    const note = baseNote({
      staff_note_state: [{ user_id: ANTONIO, archived_at: null, snoozed_until: "2026-12-01T00:00:00.000Z" }],
      staff_note_replies: [
        { id: "r1", author_user_id: LUCA, author_name: "Luca", body: "on it", created_at: "2026-09-02T10:00:00.000Z" },
      ],
    })
    expect(computeNoteAlerts([note], [], ANTONIO, NOW)).toHaveLength(0)
  })
})

describe("computeNoteAlerts — note_update", () => {
  it("fires when the note changed since it was created (a share or an edit)", () => {
    const note = baseNote({ updated_at: "2026-09-02T10:00:00.000Z" })
    const alerts = computeNoteAlerts([note], [], LUCA, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe("note_update")
  })

  it("does NOT fire on a brand-new, never-edited note", () => {
    const note = baseNote() // updated_at === created_at
    expect(computeNoteAlerts([note], [], LUCA, NOW)).toHaveLength(0)
  })

  it("a dismissal hides it; a LATER change resurfaces it (timestamp-compared, not existence)", () => {
    const note = baseNote({ updated_at: "2026-09-02T10:00:00.000Z" })
    const dismissedBefore: DismissalRow[] = [{ note_id: "note-1", reply_id: null, dismissed_at: "2026-09-02T11:00:00.000Z" }]
    expect(computeNoteAlerts([note], dismissedBefore, LUCA, NOW)).toHaveLength(0)

    const editedAgain = baseNote({ updated_at: "2026-09-03T10:00:00.000Z" })
    expect(computeNoteAlerts([editedAgain], dismissedBefore, LUCA, NOW)).toHaveLength(1)
  })

  it("is NOT suppressed by snooze — editNotifyTargets never checked snooze either, carried over on purpose", () => {
    const note = baseNote({
      updated_at: "2026-09-02T10:00:00.000Z",
      staff_note_state: [{ user_id: LUCA, archived_at: null, snoozed_until: "2026-12-01T00:00:00.000Z" }],
    })
    expect(computeNoteAlerts([note], [], LUCA, NOW)).toHaveLength(1)
  })
})

describe("computeNoteAlerts — ordering and shape", () => {
  it("sorts newest first across mixed notes and kinds", () => {
    const older = baseNote({
      id: "note-old",
      updated_at: "2026-09-01T09:00:00.000Z", // == created_at, so no note_update; reply carries the timestamp
      staff_note_replies: [
        { id: "r-old", author_user_id: OTHER, author_name: "Someone Else", body: "old", created_at: "2026-09-02T08:00:00.000Z" },
      ],
    })
    const newer = baseNote({
      id: "note-new",
      updated_at: "2026-09-03T08:00:00.000Z",
    })
    const alerts = computeNoteAlerts([older, newer], [], LUCA, NOW)
    expect(alerts.map((a) => a.note_id)).toEqual(["note-new", "note-old"])
  })

  it("carries a client name through from the nested account/contact select", () => {
    const note = baseNote({ accounts: { company_name: "Aumianna LLC" }, updated_at: "2026-09-02T10:00:00.000Z" })
    expect(computeNoteAlerts([note], [], LUCA, NOW)[0].client_name).toBe("Aumianna LLC")
  })
})
