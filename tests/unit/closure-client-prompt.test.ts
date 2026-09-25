import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mocks ────────────────────────────────────────────────────────────────
// Per-table canned results; every query builder method returns the builder.
// maybeSingle() resolves to tables[table]; awaiting a list query resolves to
// tables["<table>:list"] (default: empty list).
const tables: Record<string, { data: unknown; error: unknown }> = {}
const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = []

function builder(table: string) {
  const rec = { table, ops: [] as Array<[string, unknown[]]> }
  calls.push(rec)
  const single = () => Promise.resolve(tables[table] ?? { data: null, error: null })
  const list = () => Promise.resolve(tables[`${table}:list`] ?? { data: [], error: null, count: 0 })
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "neq", "gt", "is", "in", "order", "limit"]) {
    b[m] = (...args: unknown[]) => { rec.ops.push([m, args]); return b }
  }
  b.maybeSingle = () => single()
  b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => list().then(ok, bad)
  return b
}

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: vi.fn().mockResolvedValue(null) }))
vi.mock("@/lib/auth-admin-helpers", () => ({ findAuthUsersByContactId: vi.fn() }))
vi.mock("@/lib/members/resolve-primary-contact", () => ({ resolvePrimaryContact: vi.fn() }))
vi.mock("@/lib/portal/pending-closures", () => ({ getPendingClosuresOrNull: vi.fn() }))
vi.mock("@/lib/portal/action-required", () => ({ notifyClientActionRequired: vi.fn() }))

import {
  promptClientForClosureForm,
  buildClosurePromptCopy,
  interpretPromptResult,
} from "@/lib/portal/closure-client-prompt"
import { findAuthUsersByContactId } from "@/lib/auth-admin-helpers"
import { resolvePrimaryContact } from "@/lib/members/resolve-primary-contact"
import { getPendingClosuresOrNull } from "@/lib/portal/pending-closures"
import { notifyClientActionRequired } from "@/lib/portal/action-required"
import { reportSystemError } from "@/lib/system-errors"

const SD = "11111111-1111-4111-8111-111111111111"
const CONTACT = "22222222-2222-4222-8222-222222222222"
const ACCOUNT = "33333333-3333-4333-8333-333333333333"
const OK = { dispatched: true, chat: "ok", notification: "ok", email: "ok (1 sent)" }

/** Filters recorded on the n-th query against a table. */
function opsOf(table: string, nth = 0) {
  return calls.filter((c) => c.table === table)[nth]?.ops ?? []
}

function setSd(sd: Record<string, unknown> | null) {
  tables.service_deliveries = { data: sd, error: null }
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  calls.length = 0
  vi.clearAllMocks()
  tables.contacts = { data: { full_name: "Milan Test" }, error: null }
  tables.account_contacts = { data: { contact_id: CONTACT }, error: null }
  vi.mocked(findAuthUsersByContactId).mockResolvedValue([{ id: "auth-1" }] as never)
  vi.mocked(getPendingClosuresOrNull).mockResolvedValue([{ serviceDeliveryId: SD, accountId: null, companyName: null }])
  vi.mocked(notifyClientActionRequired).mockResolvedValue(OK)
})

describe("promptClientForClosureForm — gates", () => {
  it("contact closure, form owed, has login, nothing on file → sends with the per-closure wizard link", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: null })
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(o.status).toBe("sent")
    const arg = vi.mocked(notifyClientActionRequired).mock.calls[0][0]
    expect(arg.contact_id).toBe(CONTACT)
    expect(arg.service_delivery_id).toBe(SD)
    expect(arg.link).toBe(`/portal/wizard?type=closure&sd=${SD}`)
  })

  it("not a closure → skipped, nothing sent", async () => {
    setSd({ id: SD, service_type: "Tax Return", status: "active", contact_id: CONTACT, account_id: null })
    expect((await promptClientForClosureForm({ serviceDeliveryId: SD })).status).toBe("skipped")
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
  })

  it("inactive closure → skipped", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "completed", contact_id: CONTACT, account_id: null })
    expect((await promptClientForClosureForm({ serviceDeliveryId: SD })).status).toBe("skipped")
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
  })

  it("no portal login → skipped with a reason, nothing sent", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: null })
    vi.mocked(findAuthUsersByContactId).mockResolvedValue([])
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(o.status).toBe("skipped")
    expect(o.reason).toMatch(/no portal login/)
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
  })

  it("form for THIS closure already on file (not in the owed list) → skipped", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: null })
    vi.mocked(getPendingClosuresOrNull).mockResolvedValue([{ serviceDeliveryId: "other", accountId: null, companyName: null }])
    expect((await promptClientForClosureForm({ serviceDeliveryId: SD })).status).toBe("skipped")
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
  })

  it("owed-lookup failure → failed + reported, nothing sent", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: null })
    vi.mocked(getPendingClosuresOrNull).mockResolvedValue(null)
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(o.status).toBe("failed")
    expect(reportSystemError).toHaveBeenCalled()
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
  })

  it("company closure with a finished form for that company → not sent (probable duplicate)", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: ACCOUNT })
    vi.mocked(getPendingClosuresOrNull).mockResolvedValue([{ serviceDeliveryId: SD, accountId: ACCOUNT, companyName: "Old LLC" }])
    tables["closure_submissions:list"] = { data: [{ completed_at: "2026-06-01T00:00:00Z", created_at: "2026-05-30T00:00:00Z" }], error: null }
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD, force: true })
    expect(o.status).toBe("skipped")
    expect(o.reason).toMatch(/already on file \(2026-06-01\)/)
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
    // Scoped to THIS company, finished forms only.
    expect(opsOf("closure_submissions")).toEqual(expect.arrayContaining([
      ["eq", ["account_id", ACCOUNT]],
      ["in", ["status", ["completed", "reviewed"]]],
    ]))
  })

  it("contact-only closure with an older finished form → HELD (can force); force sends", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: null })
    tables["closure_submissions:list"] = { data: [{ completed_at: "2026-07-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z", submitted_data: { llc_name: "Doctor Veg LLC" } }], error: null }
    const held = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(held.status).toBe("held")
    expect(held.canForce).toBe(true)
    expect(held.reason).toMatch(/Doctor Veg LLC/)
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
    // Scoped to this person's forms with NO company attached.
    expect(opsOf("closure_submissions")).toEqual(expect.arrayContaining([
      ["eq", ["contact_id", CONTACT]],
      ["is", ["account_id", null]],
      ["in", ["status", ["completed", "reviewed"]]],
    ]))

    const forced = await promptClientForClosureForm({ serviceDeliveryId: SD, force: true })
    expect(forced.status).toBe("sent")
    expect(notifyClientActionRequired).toHaveBeenCalledTimes(1)
  })

  it("company-only SD → the company's primary contact is messaged (never account-wide)", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: null, account_id: ACCOUNT })
    vi.mocked(resolvePrimaryContact).mockResolvedValue({ outcome: "resolved", source: "members", contact: { id: CONTACT, full_name: "Milan Test", email: "m@x.com", portal_tier: "active", portal_role: null } })
    vi.mocked(getPendingClosuresOrNull).mockResolvedValue([{ serviceDeliveryId: SD, accountId: ACCOUNT, companyName: "Old LLC" }])
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(o.status).toBe("sent")
    const arg = vi.mocked(notifyClientActionRequired).mock.calls[0][0]
    expect(arg.contact_id).toBe(CONTACT)
    expect(arg.account_id).toBe(ACCOUNT)
    expect(arg.title.en).toContain("Old LLC")
  })

  it("company-only SD whose primary contact is not linked to the company → skipped", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: null, account_id: ACCOUNT })
    vi.mocked(resolvePrimaryContact).mockResolvedValue({ outcome: "resolved", source: "members", contact: { id: CONTACT, full_name: "Milan Test", email: null, portal_tier: null, portal_role: null } })
    tables.account_contacts = { data: null, error: null }
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(o.status).toBe("skipped")
    expect(o.reason).toMatch(/not linked/)
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
  })

  it("company-only SD with no primary contact → skipped", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: null, account_id: ACCOUNT })
    vi.mocked(resolvePrimaryContact).mockResolvedValue({ outcome: "not_found" })
    expect((await promptClientForClosureForm({ serviceDeliveryId: SD })).status).toBe("skipped")
  })

  it("a failed channel is reported to system errors", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: null })
    vi.mocked(notifyClientActionRequired).mockResolvedValue({ ...OK, notification: "failed: insert error" })
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(o.status).toBe("sent")
    expect(o.reason).toMatch(/one channel failed/)
    expect(reportSystemError).toHaveBeenCalled()
  })
})

describe("promptClientForClosureForm — duplicate / linkage guards (review fixes)", () => {
  it("company closure whose client is NOT linked to that company → skipped with a clear reason", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: ACCOUNT })
    tables.account_contacts = { data: null, error: null }
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(o.status).toBe("skipped")
    expect(o.reason).toMatch(/not linked/)
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
  })

  it("company already has ANOTHER open closure → skipped as a probable duplicate (even with force)", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: ACCOUNT })
    vi.mocked(getPendingClosuresOrNull).mockResolvedValue([{ serviceDeliveryId: SD, accountId: ACCOUNT, companyName: "Old LLC" }])
    tables["service_deliveries:list"] = { data: [{ id: "older-closure" }], error: null }
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD, force: true })
    expect(o.status).toBe("skipped")
    expect(o.reason).toMatch(/another open Company Closure/)
    expect(opsOf("service_deliveries", 1)).toEqual(expect.arrayContaining([
      ["neq", ["id", SD]],
      ["eq", ["account_id", ACCOUNT]],
    ]))
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
  })

  it("person already has another open contact-only closure → HELD; force sends", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: null })
    tables["service_deliveries:list"] = { data: [{ id: "other" }], error: null }
    const held = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(held.status).toBe("held")
    expect(held.canForce).toBe(true)
    expect((await promptClientForClosureForm({ serviceDeliveryId: SD, force: true })).status).toBe("sent")
  })

  it("company closure + an older finished form with no company attached → HELD (may be this company)", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: ACCOUNT })
    vi.mocked(getPendingClosuresOrNull).mockResolvedValue([{ serviceDeliveryId: SD, accountId: ACCOUNT, companyName: "Old LLC" }])
    // First closure_submissions query (company) → none; second (no-company) → one.
    let n = 0
    Object.defineProperty(tables, "closure_submissions:list", {
      configurable: true,
      get: () => (n++ === 0 ? { data: [], error: null } : { data: [{ completed_at: "2026-07-01T00:00:00Z", created_at: "2026-07-01T00:00:00Z", submitted_data: null }], error: null }),
    })
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD })
    expect(o.status).toBe("held")
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
    delete tables["closure_submissions:list"]
  })

  it("a message for this closure was sent minutes ago (bell may have failed) → not sent twice", async () => {
    setSd({ id: SD, service_type: "Company Closure", status: "active", contact_id: CONTACT, account_id: null })
    tables["portal_messages:list"] = { data: null, error: null, count: 1 } as never
    const o = await promptClientForClosureForm({ serviceDeliveryId: SD, force: true })
    expect(o.status).toBe("skipped")
    expect(notifyClientActionRequired).not.toHaveBeenCalled()
  })
})

describe("interpretPromptResult", () => {
  it("dedup skip → skipped, not failed", () => {
    const o = interpretPromptResult({ dispatched: false, chat: "skipped: duplicate within dedup window", notification: "x", email: "x" }, "Milan")
    expect(o.status).toBe("skipped")
  })
  it("chat and email both failed → failed", () => {
    const o = interpretPromptResult({ dispatched: true, chat: "failed: a", notification: "ok", email: "failed: b" }, "Milan")
    expect(o.status).toBe("failed")
  })
  it("email partial but chat ok → sent with warning", () => {
    const o = interpretPromptResult({ dispatched: true, chat: "ok", notification: "ok", email: "partial: 1 sent, 1 failed" }, "Milan")
    expect(o.status).toBe("sent")
    expect(o.reason).toMatch(/one channel failed/)
  })
  it("all ok → sent", () => {
    expect(interpretPromptResult(OK, "Milan").reason).toMatch(/chat, bell and email/)
  })
  it("no email on file → sent, but the toast does not claim an email", () => {
    const o = interpretPromptResult({ ...OK, email: "skipped: no recipient email" }, "Milan")
    expect(o.status).toBe("sent")
    expect(o.reason).toMatch(/no email sent: no recipient email/)
  })
})

describe("buildClosurePromptCopy", () => {
  it("names the company when known, in both languages", () => {
    const c = buildClosurePromptCopy("Old LLC")
    expect(c.title.en).toContain("Old LLC")
    expect(c.message.it).toContain("Old LLC")
    expect(c.message.it).toContain("Completa Registrazione — Chiusura Società")
  })
  it("generic wording when the company is unknown", () => {
    const c = buildClosurePromptCopy(null)
    expect(c.message.en).toContain("your previous company")
    expect(c.title.it).toBe("Modulo di chiusura società")
  })
})
