/**
 * Tests for lib/messaging/contact-match.ts — findContactByPhone.
 *
 * Covers the exact behavior the WhatsApp contact-match banner depends on:
 * a lead match wins over a contact match, phone formatting differences don't
 * break the match, a candidate sharing only the last 8 digits (different
 * country code) is correctly rejected, and no match returns null rather
 * than throwing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

type LeadRow = { id: string; full_name: string; phone: string | null }
type ContactRow = {
  id: string
  full_name: string
  phone: string | null
  phone_2: string | null
  account_contacts: Array<{ accounts: { company_name: string } }>
}

let leadRows: LeadRow[] = []
let contactRows: ContactRow[] = []

vi.mock("@/lib/supabase-admin", () => {
  const from = vi.fn((table: string) => {
    if (table === "leads") {
      return {
        select: () => ({
          ilike: () => ({
            limit: () => Promise.resolve({ data: leadRows, error: null }),
          }),
        }),
      }
    }
    if (table === "contacts") {
      return {
        select: () => ({
          or: () => ({
            limit: () => Promise.resolve({ data: contactRows, error: null }),
          }),
        }),
      }
    }
    throw new Error(`unexpected table: ${table}`)
  })
  return { supabaseAdmin: { from } }
})

import { findContactByPhone } from "@/lib/messaging/contact-match"

beforeEach(() => {
  leadRows = []
  contactRows = []
})

describe("findContactByPhone", () => {
  it("returns null for a phone number too short to match reliably", async () => {
    const result = await findContactByPhone("+123")
    expect(result).toBeNull()
  })

  it("returns null when neither a lead nor a contact matches", async () => {
    const result = await findContactByPhone("+17274521093")
    expect(result).toBeNull()
  })

  it("matches a lead regardless of phone formatting differences (same full number)", async () => {
    leadRows = [{ id: "lead-1", full_name: "Marco Bianchi", phone: "+1 (727) 452-1093" }]
    const result = await findContactByPhone("17274521093")
    expect(result).toEqual({ type: "lead", id: "lead-1", name: "Marco Bianchi" })
  })

  it("a lead match wins even when a contact would also match", async () => {
    leadRows = [{ id: "lead-1", full_name: "Marco Bianchi", phone: "+17274521093" }]
    contactRows = [{ id: "contact-1", full_name: "Someone Else", phone: "+17274521093", phone_2: null, account_contacts: [] }]
    const result = await findContactByPhone("+17274521093")
    expect(result?.type).toBe("lead")
  })

  it("matches a contact and surfaces its linked account name", async () => {
    contactRows = [{
      id: "contact-1",
      full_name: "Adam Mihaly",
      phone: "+17274521093",
      phone_2: null,
      account_contacts: [{ accounts: { company_name: "THW Global LLC" } }],
    }]
    const result = await findContactByPhone("+17274521093")
    expect(result).toEqual({
      type: "contact",
      id: "contact-1",
      name: "Adam Mihaly",
      accountName: "THW Global LLC",
    })
  })

  it("matches a standalone contact with no linked account", async () => {
    contactRows = [{ id: "contact-2", full_name: "Giulio Rossi", phone: "+17274521093", phone_2: null, account_contacts: [] }]
    const result = await findContactByPhone("+17274521093")
    expect(result).toEqual({
      type: "contact",
      id: "contact-2",
      name: "Giulio Rossi",
      accountName: null,
    })
  })

  it("does NOT match a contact whose full number differs, even sharing the last 8 digits", async () => {
    // Real incident, 2026-09-18: an Albanian and an Italian number can share
    // 8 trailing digits by coincidence — the old substring rule would have
    // wrongly matched them. The full country code must agree too.
    contactRows = [{ id: "contact-3", full_name: "Wrong Country", phone: "+355 69 867 8746", phone_2: null, account_contacts: [] }]
    const result = await findContactByPhone("+39 69 867 8746")
    expect(result).toBeNull()
  })

  it("matches via phone_2 when phone_1 differs", async () => {
    contactRows = [{ id: "contact-4", full_name: "Second Number", phone: "+15550001111", phone_2: "+17274521093", account_contacts: [] }]
    const result = await findContactByPhone("+17274521093")
    expect(result?.id).toBe("contact-4")
  })
})
