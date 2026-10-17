import { describe, it, expect, vi, beforeEach } from "vitest"

// capture what is written to portal_messages
let inserted: Record<string, unknown> | null = null
let existing: { id: string } | null = null
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ like: () => ({ is: () => ({ limit: () => ({ maybeSingle: async () => ({ data: existing }) }) }) }) }) }),
      insert: (row: Record<string, unknown>) => { inserted = row; return { select: () => ({ single: async () => ({ data: { id: "m1" }, error: null }) }) } },
    }),
  },
}))

import { emitPersonLeftEvent } from "@/lib/portal/chat-events"

beforeEach(() => { inserted = null; existing = null })

describe("emitPersonLeftEvent (the Calendar's What's New)", () => {
  it("posts a staff-only note on the company with the marker kind person_left", async () => {
    const r = await emitPersonLeftEvent({ noteId: "n1", accountId: "acc", personName: "Mario Rossi", companyName: "Acme LLC", via: "member-delete", onlyLinkedPerson: false })
    expect(r.emitted).toBe(true)
    expect(inserted).toMatchObject({ account_id: "acc", contact_id: null, sender_type: "system" })
    const msg = String(inserted?.message)
    expect(msg).toContain("Mario Rossi was removed as a member on Acme LLC.")
    expect(msg).toContain("send them by hand")
    expect(msg).not.toContain("NO linked person")
    expect(msg).toContain("<!-- chat-event: kind=person_left src=storage_check_notes:n1 -->")
  })
  it("says so when the company is left with nobody", async () => {
    await emitPersonLeftEvent({ noteId: "n2", accountId: "acc", personName: null, companyName: null, via: "unlink", onlyLinkedPerson: true })
    const msg = String(inserted?.message)
    expect(msg).toContain("A person was unlinked from the company on this company.")
    expect(msg).toContain("NO linked person")
  })
  it("is idempotent on the note id (a repeat posts nothing)", async () => {
    existing = { id: "old" }
    const r = await emitPersonLeftEvent({ noteId: "n1", accountId: "acc", personName: "X", companyName: "Y", via: "revoke-access", onlyLinkedPerson: false })
    expect(r).toMatchObject({ emitted: false, reason: "already_emitted" })
    expect(inserted).toBeNull()
  })
})
