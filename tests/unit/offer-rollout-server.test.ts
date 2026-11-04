/**
 * Server decision for the offer-builder rollout (lib/offers/rollout-server.ts): for ONE record, which new pieces may
 * be shown. Off / test / on per piece; "test" looks up whether the record is marked is_test. Fake database, no network.
 * Fails CLOSED everywhere.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  settings: { data: [] as Array<{ key: string; value: unknown }> | null, error: null as null | { message: string } },
  rows: {} as Record<string, { data: unknown; error: null | { message: string } }>,
  calls: [] as string[],
  writes: 0,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let filter = ""
      const chain: Record<string, unknown> = {
        select: () => chain,
        in: () => {
          h.calls.push(`${table}.in`)
          return Promise.resolve(h.settings)
        },
        eq: (_col: string, val: string) => {
          filter = val
          return chain
        },
        maybeSingle: async () => {
          h.calls.push(`${table}:${filter}`)
          return h.rows[`${table}:${filter}`] ?? { data: null, error: null }
        },
        insert: () => { h.writes++; return chain },
        update: () => { h.writes++; return chain },
        upsert: () => { h.writes++; return chain },
        delete: () => { h.writes++; return chain },
      }
      return chain
    },
  },
}))

import { offerBuilderFeaturesFor, pickSubjectRecord } from "@/lib/offers/rollout-server"

const ACCT = "11111111-1111-4111-8111-111111111111"
const LEAD = "22222222-2222-4222-8222-222222222222"
const CONTACT = "33333333-3333-4333-8333-333333333333"
const ADD = "offer_add_service_enabled"
const BOX = "offer_send_check_box_enabled"

const setSettings = (add: unknown, box: unknown) => {
  const data: Array<{ key: string; value: unknown }> = []
  if (add !== undefined) data.push({ key: ADD, value: add })
  if (box !== undefined) data.push({ key: BOX, value: box })
  h.settings = { data, error: null }
}
const rec = (table: string, id: string, is_test: boolean | null) => { h.rows[`${table}:${id}`] = { data: { is_test }, error: null } }

beforeEach(() => {
  h.settings = { data: [], error: null }
  h.rows = {}
  h.calls = []
  h.writes = 0
})

describe("pickSubjectRecord — the most specific record decides", () => {
  it("company first, then lead, then contact", () => {
    expect(pickSubjectRecord({ accountId: ACCT, leadId: LEAD, contactId: CONTACT })).toEqual({ table: "accounts", id: ACCT })
    expect(pickSubjectRecord({ leadId: LEAD, contactId: CONTACT })).toEqual({ table: "leads", id: LEAD })
    expect(pickSubjectRecord({ contactId: CONTACT })).toEqual({ table: "contacts", id: CONTACT })
  })
  it("nothing given, or ids that are not uuids, is no record at all", () => {
    expect(pickSubjectRecord({})).toBeNull()
    expect(pickSubjectRecord({ accountId: "not-a-uuid", leadId: "' or 1=1 --", contactId: "" })).toBeNull()
    expect(pickSubjectRecord({ accountId: null, leadId: undefined, contactId: null })).toBeNull()
  })
  it("a bad id is skipped, the next good one is used", () => {
    expect(pickSubjectRecord({ accountId: "nope", leadId: LEAD })).toEqual({ table: "leads", id: LEAD })
  })
})

describe("settings: off, or a failed read, shows nothing and looks at no record", () => {
  it("no rows at all (production today) = everything hidden, and only the settings were read", async () => {
    setSettings(undefined, undefined)
    expect(await offerBuilderFeaturesFor({ accountId: ACCT })).toEqual({ addService: false, sendCheckBox: false })
    expect(h.calls).toEqual(["app_settings.in"])
  })
  it("a failed settings read hides everything", async () => {
    h.settings = { data: null, error: { message: "db down" } }
    expect(await offerBuilderFeaturesFor({ accountId: ACCT })).toEqual({ addService: false, sendCheckBox: false })
    h.settings = { data: [{ key: ADD, value: true }], error: { message: "partial" } }
    expect(await offerBuilderFeaturesFor({ accountId: ACCT })).toEqual({ addService: false, sendCheckBox: false })
  })
  it.each([["false", false], ["'true'", "true"], ["'on'", "on"], ["'TEST'", "TEST"], ["the number 1", 1], ["null", null]])("a stored %s is off", async (_l, v) => {
    setSettings(v, v)
    rec("accounts", ACCT, true)
    expect(await offerBuilderFeaturesFor({ accountId: ACCT })).toEqual({ addService: false, sendCheckBox: false })
  })
})

describe("ON = everyone, and no record needs to be looked up", () => {
  it("shows for a real record, a test record, an unknown record and no record at all", async () => {
    setSettings(true, true)
    rec("accounts", ACCT, false)
    for (const subject of [{ accountId: ACCT }, { accountId: LEAD }, {}, { token: "tok-x" }]) {
      expect(await offerBuilderFeaturesFor(subject)).toEqual({ addService: true, sendCheckBox: true })
    }
    expect(h.calls.filter((c) => !c.startsWith("app_settings"))).toEqual([])
  })
})

describe("TEST = only records marked as test", () => {
  it("a test company shows the piece; a real company does not", async () => {
    setSettings("test", "test")
    rec("accounts", ACCT, true)
    expect(await offerBuilderFeaturesFor({ accountId: ACCT })).toEqual({ addService: true, sendCheckBox: true })
    rec("accounts", ACCT, false)
    expect(await offerBuilderFeaturesFor({ accountId: ACCT })).toEqual({ addService: false, sendCheckBox: false })
  })
  it("a record with is_test empty (null) is a REAL record", async () => {
    setSettings("test", "test")
    rec("leads", LEAD, null)
    expect(await offerBuilderFeaturesFor({ leadId: LEAD })).toEqual({ addService: false, sendCheckBox: false })
  })
  it("a record that cannot be found, a failed read, or no record given = hidden (unknown is never test)", async () => {
    setSettings("test", "test")
    expect(await offerBuilderFeaturesFor({ leadId: LEAD })).toEqual({ addService: false, sendCheckBox: false }) // not found
    h.rows[`leads:${LEAD}`] = { data: null, error: { message: "boom" } }
    expect(await offerBuilderFeaturesFor({ leadId: LEAD })).toEqual({ addService: false, sendCheckBox: false }) // read failed
    expect(await offerBuilderFeaturesFor({})).toEqual({ addService: false, sendCheckBox: false }) // nothing given
    expect(await offerBuilderFeaturesFor({ accountId: "garbage" })).toEqual({ addService: false, sendCheckBox: false })
  })
  it("the company decides over the lead and the lead over the contact", async () => {
    setSettings("test", "test")
    rec("accounts", ACCT, false)
    rec("leads", LEAD, true)
    rec("contacts", CONTACT, true)
    // real company, test lead + test contact -> the company wins -> hidden
    expect(await offerBuilderFeaturesFor({ accountId: ACCT, leadId: LEAD, contactId: CONTACT })).toEqual({ addService: false, sendCheckBox: false })
    // test company with an unmarked contact -> shown
    rec("accounts", ACCT, true)
    rec("contacts", CONTACT, false)
    expect(await offerBuilderFeaturesFor({ accountId: ACCT, contactId: CONTACT })).toEqual({ addService: true, sendCheckBox: true })
    // no company: the lead decides over the contact
    rec("leads", LEAD, false)
    rec("contacts", CONTACT, true)
    expect(await offerBuilderFeaturesFor({ leadId: LEAD, contactId: CONTACT })).toEqual({ addService: false, sendCheckBox: false })
    // only a contact
    expect(await offerBuilderFeaturesFor({ contactId: CONTACT })).toEqual({ addService: true, sendCheckBox: true })
  })
  it("only the deciding record is read", async () => {
    setSettings("test", "test")
    rec("accounts", ACCT, true)
    await offerBuilderFeaturesFor({ accountId: ACCT, leadId: LEAD, contactId: CONTACT })
    expect(h.calls).toEqual(["app_settings.in", `accounts:${ACCT}`])
  })
})

describe("each piece is decided on its own", () => {
  it("one on + one test: the 'on' piece shows for a real record, the 'test' piece does not", async () => {
    setSettings(true, "test")
    rec("leads", LEAD, false)
    expect(await offerBuilderFeaturesFor({ leadId: LEAD })).toEqual({ addService: true, sendCheckBox: false })
    rec("leads", LEAD, true)
    expect(await offerBuilderFeaturesFor({ leadId: LEAD })).toEqual({ addService: true, sendCheckBox: true })
  })
  it("one test + one off: only the test piece shows, and only for a test record", async () => {
    setSettings("test", undefined)
    rec("leads", LEAD, true)
    expect(await offerBuilderFeaturesFor({ leadId: LEAD })).toEqual({ addService: true, sendCheckBox: false })
  })
})

describe("an offer's token says which record it belongs to", () => {
  it("the offer's company decides", async () => {
    setSettings(undefined, "test")
    h.rows["offers:tok-1"] = { data: { account_id: ACCT, lead_id: LEAD, contact_id: null }, error: null }
    rec("accounts", ACCT, true)
    expect(await offerBuilderFeaturesFor({ token: "tok-1" })).toEqual({ addService: false, sendCheckBox: true })
    rec("accounts", ACCT, false)
    expect(await offerBuilderFeaturesFor({ token: "tok-1" })).toEqual({ addService: false, sendCheckBox: false })
  })
  it("an offer with no company falls back to its lead, then its contact", async () => {
    setSettings(undefined, "test")
    h.rows["offers:tok-2"] = { data: { account_id: null, lead_id: LEAD, contact_id: CONTACT }, error: null }
    rec("leads", LEAD, true)
    expect(await offerBuilderFeaturesFor({ token: "tok-2" })).toEqual({ addService: false, sendCheckBox: true })
    h.rows["offers:tok-3"] = { data: { account_id: null, lead_id: null, contact_id: CONTACT }, error: null }
    rec("contacts", CONTACT, false)
    expect(await offerBuilderFeaturesFor({ token: "tok-3" })).toEqual({ addService: false, sendCheckBox: false })
  })
  it("an unknown token, or a failed offer read with nothing else known, is hidden", async () => {
    setSettings(undefined, "test")
    expect(await offerBuilderFeaturesFor({ token: "no-such-offer" })).toEqual({ addService: false, sendCheckBox: false })
    h.rows["offers:tok-4"] = { data: null, error: { message: "boom" } }
    expect(await offerBuilderFeaturesFor({ token: "tok-4" })).toEqual({ addService: false, sendCheckBox: false })
  })
  it("a failed offer read still uses explicit ids when the screen gave some", async () => {
    setSettings(undefined, "test")
    h.rows["offers:tok-5"] = { data: null, error: { message: "boom" } }
    rec("leads", LEAD, true)
    expect(await offerBuilderFeaturesFor({ token: "tok-5", leadId: LEAD })).toEqual({ addService: false, sendCheckBox: true })
  })
})

describe("it only ever reads", () => {
  it("no insert / update / upsert / delete in any path", async () => {
    setSettings("test", true)
    rec("accounts", ACCT, true)
    await offerBuilderFeaturesFor({ accountId: ACCT, token: "tok-1" })
    setSettings(undefined, undefined)
    await offerBuilderFeaturesFor({})
    h.settings = { data: null, error: { message: "x" } }
    await offerBuilderFeaturesFor({ leadId: LEAD })
    expect(h.writes).toBe(0)
  })
})
