/**
 * MMLLC member resolution for account-scoped portal sends (2026-07-17 council
 * WS0): the send used to pick an arbitrary member via .limit(1) with no
 * ordering — a co-owner could get another member's message + email.
 */

import { describe, it, expect } from "vitest"
import { pickPrimaryContactId, type AccountContactLink } from "@/lib/ai-agent/worker-tools"

describe("pickPrimaryContactId", () => {
  it("single member → that member, not ambiguous", () => {
    expect(pickPrimaryContactId([{ contact_id: "c1" }])).toEqual({ contactId: "c1", ambiguous: false })
  })

  it("no members with a contact → null", () => {
    expect(pickPrimaryContactId([{ contact_id: null }])).toEqual({ contactId: null, ambiguous: false })
    expect(pickPrimaryContactId([])).toEqual({ contactId: null, ambiguous: false })
  })

  it("prefers the explicit primary flag over everything", () => {
    const links: AccountContactLink[] = [
      { contact_id: "member", role: "owner", ownership_pct: 90 },
      { contact_id: "primary", role: "member", ownership_pct: 10, is_primary: true },
    ]
    expect(pickPrimaryContactId(links)).toEqual({ contactId: "primary", ambiguous: false })
  })

  it("prefers an owner/sole-member role when no primary flag", () => {
    const links: AccountContactLink[] = [
      { contact_id: "m", role: "Member", ownership_pct: 60 },
      { contact_id: "o", role: "Owner", ownership_pct: 40 },
    ]
    expect(pickPrimaryContactId(links)).toEqual({ contactId: "o", ambiguous: false })
    expect(pickPrimaryContactId([
      { contact_id: "sole", role: "Sole Member" },
      { contact_id: "x", role: "authorized_representative" },
    ])).toEqual({ contactId: "sole", ambiguous: false })
  })

  it("falls back to highest ownership when roles are equal", () => {
    const links: AccountContactLink[] = [
      { contact_id: "small", role: "member", ownership_pct: 25 },
      { contact_id: "big", role: "member", ownership_pct: 75 },
    ]
    expect(pickPrimaryContactId(links)).toEqual({ contactId: "big", ambiguous: false })
  })

  it("multiple members with NO owner signal → deterministic first, flagged ambiguous", () => {
    const links: AccountContactLink[] = [
      { contact_id: "a", role: "member" },
      { contact_id: "b", role: "member" },
    ]
    const r = pickPrimaryContactId(links)
    expect(r.contactId).toBe("a")
    expect(r.ambiguous).toBe(true)
  })

  it("is stable regardless of input order (no arbitrary pick)", () => {
    const links: AccountContactLink[] = [
      { contact_id: "member", role: "member", ownership_pct: 20 },
      { contact_id: "owner", role: "owner", ownership_pct: 80 },
    ]
    const forward = pickPrimaryContactId(links)
    const reversed = pickPrimaryContactId([...links].reverse())
    expect(forward.contactId).toBe("owner")
    expect(reversed.contactId).toBe("owner")
  })
})
