/**
 * Tests for app/api/inbox/whatsapp-new/create-record/route.ts
 *
 * Covers the "attach to an existing contact" branch (dev job f331cd43,
 * 2026-09-18) — added after "Contact of an existing client" silently
 * created a duplicate Marinela Marku instead of attaching to her real,
 * already-existing contact record.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireStaffRoute = vi.fn()
vi.mock("@/lib/auth/require-staff-route", () => ({
  requireStaffRoute: () => requireStaffRoute(),
}))

const groupSingle = vi.fn()
const contactSingle = vi.fn()
const contactsUpdate = vi.fn()
const groupsUpdate = vi.fn()
const accountContactsInsert = vi.fn()
const contactsInsert = vi.fn()

vi.mock("@/lib/supabase-admin", () => {
  const from = vi.fn((table: string) => {
    if (table === "messaging_groups") {
      return {
        select: () => ({ eq: () => ({ single: groupSingle }) }),
        update: (payload: unknown) => { groupsUpdate(payload); return { eq: () => Promise.resolve({ data: null, error: null }) } },
      }
    }
    if (table === "contacts") {
      return {
        select: () => ({ eq: () => ({ single: contactSingle }) }),
        update: (payload: unknown) => { contactsUpdate(payload); return { eq: () => Promise.resolve({ data: null, error: null }) } },
        insert: (payload: unknown) => { contactsInsert(payload); return { select: () => ({ single: () => Promise.resolve({ data: { id: "new-contact-id", full_name: payload && (payload as { full_name: string }).full_name }, error: null }) }) } },
      }
    }
    if (table === "account_contacts") {
      return { insert: (payload: unknown) => { accountContactsInsert(payload); return Promise.resolve({ data: null, error: null }) } }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { supabaseAdmin: { from } }
})

import { POST } from "@/app/api/inbox/whatsapp-new/create-record/route"

function makeRequest(body: unknown) {
  return new NextRequest(new URL("http://localhost/api/inbox/whatsapp-new/create-record"), {
    method: "POST",
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireStaffRoute.mockResolvedValue(null)
  groupSingle.mockResolvedValue({ data: { id: "g1", external_group_id: "15551234567@c.us" }, error: null })
})

describe("POST /api/inbox/whatsapp-new/create-record — attach to existing contact", () => {
  it("attaches to the existing contact and fills a blank phone, without creating a new contact", async () => {
    contactSingle.mockResolvedValue({ data: { id: "c1", full_name: "Marinela Marku", phone: null }, error: null })

    const res = await POST(makeRequest({ groupId: "g1", existingContactId: "c1", accountId: "a1" }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.record).toEqual({ type: "contact", id: "c1", name: "Marinela Marku" })
    expect(contactsInsert).not.toHaveBeenCalled()
    expect(contactsUpdate).toHaveBeenCalledWith({ phone: "+15551234567" })
    expect(groupsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ contact_id: "c1", account_id: "a1", group_name: "Marinela Marku" })
    )
  })

  it("never overwrites a contact who already has a real phone number on file", async () => {
    contactSingle.mockResolvedValue({ data: { id: "c2", full_name: "Has A Real Phone", phone: "+15550001111" }, error: null })

    const res = await POST(makeRequest({ groupId: "g1", existingContactId: "c2", accountId: "a1" }))

    expect(res.status).toBe(200)
    expect(contactsUpdate).not.toHaveBeenCalled()
    expect(contactsInsert).not.toHaveBeenCalled()
  })

  it("404s when the existing contact id doesn't resolve to a real row", async () => {
    contactSingle.mockResolvedValue({ data: null, error: { message: "not found" } })

    const res = await POST(makeRequest({ groupId: "g1", existingContactId: "missing" }))

    expect(res.status).toBe(404)
    expect(groupsUpdate).not.toHaveBeenCalled()
  })

  it("still creates a new contact for the normal (non-attach) path", async () => {
    const res = await POST(makeRequest({ groupId: "g1", fullName: "Brand New Person", recordType: "contact", accountId: "a1" }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(contactsInsert).toHaveBeenCalled()
    expect(body.record.name).toBe("Brand New Person")
    expect(accountContactsInsert).toHaveBeenCalledWith({ account_id: "a1", contact_id: "new-contact-id" })
  })
})
