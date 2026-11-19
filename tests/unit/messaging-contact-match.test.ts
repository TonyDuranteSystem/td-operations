/**
 * Tests for lib/messaging/contact-match.ts — the number lookup behind the WhatsApp chat bar.
 * Digits only (spaces/dashes never matter), the ENTIRE number must match, every match is returned, a lead that became a matched
 * contact is the same person, and a failed read throws instead of looking like "no match".
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Row = Record<string, unknown>
let leadRows: Row[] = []
let contactRows: Row[] = []
let readError: string | null = null

vi.mock("@/lib/supabase-admin", () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "not", "is", "or", "order"]) b[m] = () => b
    b.range = (from: number, to: number) => {
      if (readError) return Promise.resolve({ data: null, error: { message: readError } })
      const rows = table === "leads" ? leadRows : contactRows
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import { findAllMatchesByPhone, matchPhoneRecords } from "@/lib/messaging/contact-match"

beforeEach(() => {
  leadRows = []
  contactRows = []
  readError = null
})

describe("matchPhoneRecords", () => {
  it("finds a number however it is written", () => {
    const contacts = [{ id: "c1", full_name: "Santo Catania", phone: "+39 349 703 7513", account_contacts: [{ account_id: "a1", accounts: { company_name: "Trade Charls LLC" } }] }]
    for (const chat of ["+393497037513", "393497037513", "+39 349 70 37 513", "0039 349 703 7513".replace(/^00/, "")]) {
      const r = matchPhoneRecords(chat, [], contacts)
      expect(r).toEqual([{ type: "contact", id: "c1", name: "Santo Catania", accountName: "Trade Charls LLC", accountId: "a1" }])
    }
  })

  it("matches on any of a contact's four phone slots, and a lead's phone", () => {
    const contacts = [
      { id: "c2", full_name: "B", phone: "+1 111 111 1111", phone_4: "+1 (727) 452-1093" },
    ]
    const leads = [{ id: "l1", full_name: "L", phone: "1-727-452-1093" }]
    const r = matchPhoneRecords("+17274521093", leads, contacts)
    expect(r.map((m) => `${m.type}:${m.id}`)).toEqual(["contact:c2", "lead:l1"])
  })

  it("a number saved WITHOUT its country code does not match (the whole number must match)", () => {
    expect(matchPhoneRecords("+17274521093", [], [{ id: "c8", full_name: "N", phone: "(727) 452-1093" }])).toEqual([])
  })

  it("requires the ENTIRE number — a number that merely ends the same never matches", () => {
    const contacts = [{ id: "c3", full_name: "X", phone: "+1 727 452 1093" }]
    expect(matchPhoneRecords("+390 727 452 1093".replace(/\s/g, ""), [], contacts)).toEqual([])
    expect(matchPhoneRecords("+17274521093", [], [{ id: "c4", full_name: "Y", phone: "452 1093" }])).toEqual([])
  })

  it("never matches blank values or a chat number that is not a real phone", () => {
    const contacts = [{ id: "c5", full_name: "Z", phone: null, phone_2: "", phone_3: "-", phone_4: null }]
    expect(matchPhoneRecords("+17274521093", [], contacts)).toEqual([])
    expect(matchPhoneRecords("", [], contacts)).toEqual([])
    expect(matchPhoneRecords("1234567", [], [{ id: "c6", full_name: "S", phone: "1234567" }])).toEqual([])
    expect(matchPhoneRecords("1203630000000000000", [], [{ id: "c7", full_name: "G", phone: "1203630000000000000" }])).toEqual([])
  })

  it("returns every match, the same contact only once, and skips test records", () => {
    const contacts = [
      { id: "c1", full_name: "A", phone: "+39 349 703 7513", phone_2: "393497037513" },
      { id: "c2", full_name: "B", phone: "393497037513" },
      { id: "c3", full_name: "Test", phone: "393497037513", is_test: true },
    ]
    const leads = [{ id: "l1", full_name: "A lead", phone: "+39 349 703 7513" }, { id: "l2", full_name: "T", phone: "393497037513", is_test: true }]
    const r = matchPhoneRecords("+393497037513", leads, contacts)
    expect(r.map((m) => m.id)).toEqual(["c1", "c2", "l1"])
  })

  it("a lead that became a matched contact is the same person: only the contact is shown", () => {
    const contacts = [{ id: "c1", full_name: "Santo", phone: "+39 349 703 7513" }]
    const leads = [
      { id: "l1", full_name: "Santo", phone: "393497037513", converted_to_contact_id: "c1" },
      { id: "l2", full_name: "Santo", phone: "393497037513", converted_to_contact_id: null },
    ]
    expect(matchPhoneRecords("+393497037513", leads, contacts).map((m) => m.id)).toEqual(["c1", "l2"])
  })
})

describe("findAllMatchesByPhone", () => {
  it("reads the records and returns every match", async () => {
    contactRows = [{ id: "c1", full_name: "Santo", phone: "+39 349 703 7513", account_contacts: [] }]
    leadRows = [{ id: "l1", full_name: "Santo", phone: "+39 349 703 7513", converted_to_contact_id: null }]
    const r = await findAllMatchesByPhone("+393497037513")
    expect(r.map((m) => m.id)).toEqual(["c1", "l1"])
  })

  it("reads past the first 1,000 rows", async () => {
    contactRows = Array.from({ length: 1200 }, (_, i) => ({ id: `c${i}`, full_name: `P${i}`, phone: `+1 555 ${String(1000000 + i).slice(1)}` }))
    contactRows.push({ id: "target", full_name: "Last one", phone: "+39 349 703 7513" })
    const r = await findAllMatchesByPhone("+393497037513")
    expect(r.map((m) => m.id)).toEqual(["target"])
  })

  it("does not touch the database for a number that is not a real phone", async () => {
    readError = "should not be read"
    expect(await findAllMatchesByPhone("+12")).toEqual([])
  })

  it("throws when the database cannot be read — a failed read is never 'no match'", async () => {
    readError = "timeout"
    await expect(findAllMatchesByPhone("+393497037513")).rejects.toThrow(/timeout/)
  })
})
