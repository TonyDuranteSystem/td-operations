/**
 * Tests for lib/messaging/contact-match.ts — findContactByPhone.
 *
 * Covers the exact behavior the WhatsApp contact-match banner depends on:
 * a lead match wins over a contact match, phone formatting differences don't
 * break the match, and no match returns null rather than throwing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

type LeadRow = { id: string; full_name: string } | null
type ContactRow = { id: string; full_name: string; account_contacts: Array<{ accounts: { company_name: string } }> } | null

let leadResult: LeadRow = null
let contactResult: ContactRow = null

vi.mock("@/lib/supabase-admin", () => {
  const from = vi.fn((table: string) => {
    if (table === "leads") {
      return {
        select: () => ({
          ilike: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: leadResult, error: null }),
            }),
          }),
        }),
      }
    }
    if (table === "contacts") {
      return {
        select: () => ({
          or: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve({ data: contactResult, error: null }),
            }),
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
  leadResult = null
  contactResult = null
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

  it("matches a lead regardless of phone formatting differences", async () => {
    leadResult = { id: "lead-1", full_name: "Marco Bianchi" }
    const result = await findContactByPhone("+1 (727) 452-1093")
    expect(result).toEqual({ type: "lead", id: "lead-1", name: "Marco Bianchi" })
  })

  it("a lead match wins even when a contact would also match", async () => {
    leadResult = { id: "lead-1", full_name: "Marco Bianchi" }
    contactResult = { id: "contact-1", full_name: "Someone Else", account_contacts: [] }
    const result = await findContactByPhone("+17274521093")
    expect(result?.type).toBe("lead")
  })

  it("matches a contact and surfaces its linked account name", async () => {
    contactResult = {
      id: "contact-1",
      full_name: "Adam Mihaly",
      account_contacts: [{ accounts: { company_name: "THW Global LLC" } }],
    }
    const result = await findContactByPhone("+17274521093")
    expect(result).toEqual({
      type: "contact",
      id: "contact-1",
      name: "Adam Mihaly",
      accountName: "THW Global LLC",
    })
  })

  it("matches a standalone contact with no linked account", async () => {
    contactResult = { id: "contact-2", full_name: "Giulio Rossi", account_contacts: [] }
    const result = await findContactByPhone("+17274521093")
    expect(result).toEqual({
      type: "contact",
      id: "contact-2",
      name: "Giulio Rossi",
      accountName: null,
    })
  })
})
