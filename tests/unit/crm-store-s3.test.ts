import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { rpc: vi.fn() } }))

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  fileAccess, visibleFiles, recordView, sendCheck, recordSend, setPublished, setFilingStatus,
  endMembership, reopenMembership, revokeStoreAccess, restoreStoreAccess, StoreAccessDeniedError, StoreSendOutsideRulesError,
} from "@/lib/crm-store/visibility"

const admin = { id: "staff-1", app_metadata: { role: "admin" } }
const team = { id: "staff-2", app_metadata: { role: "team" } }
const client = { id: "c-1", app_metadata: { role: "client" } }
const partner = { id: "p-1", app_metadata: { role: "partner" } }
const noRole = { id: "x-1", app_metadata: {} }
const rpc = () => vi.mocked(supabaseAdmin.rpc)

beforeEach(() => { rpc().mockReset() })

describe("portal viewer checks", () => {
  it("passes exactly one viewer to the database and reports ok / ok_leaving as allowed", async () => {
    rpc().mockResolvedValueOnce({ data: "ok", error: null } as never)
    expect(await fileAccess("f1", { contactId: "c1" })).toEqual({ allowed: true, code: "ok" })
    expect(rpc().mock.calls[0]).toEqual(["store_file_access", { p_file_id: "f1", p_contact_id: "c1", p_teammate_id: null }])
    rpc().mockResolvedValueOnce({ data: "ok_leaving", error: null } as never)
    expect((await fileAccess("f1", { teammateId: "t1" })).allowed).toBe(true)
    expect(rpc().mock.calls[1][1]).toEqual({ p_file_id: "f1", p_contact_id: null, p_teammate_id: "t1" })
  })
  it("fails closed on every refusal code", async () => {
    for (const code of ["not_the_person", "no_company_access", "not_client_visible", "company_hidden", "personal_not_for_teammates", "unfiled"]) {
      rpc().mockResolvedValueOnce({ data: code, error: null } as never)
      expect(await fileAccess("f1", { contactId: "c1" })).toEqual({ allowed: false, code })
    }
  })
  it("refuses an ambiguous or missing viewer before touching the database", async () => {
    await expect(fileAccess("f1", { contactId: "c1", teammateId: "t1" } as never)).rejects.toThrow(/exactly one/)
    await expect(fileAccess("f1", {} as never)).rejects.toThrow(/exactly one/)
    await expect(visibleFiles({ contactId: "" } as never)).rejects.toThrow(/exactly one/)
    expect(rpc()).not.toHaveBeenCalled()
  })
  it("lists through the per-file database check and records views", async () => {
    rpc().mockResolvedValueOnce({ data: null, error: null } as never)
    expect(await visibleFiles({ contactId: "c1" }, "o1")).toEqual([])
    expect(rpc().mock.calls[0]).toEqual(["store_visible_files", { p_contact_id: "c1", p_teammate_id: null, p_owner_id: "o1" }])
    rpc().mockResolvedValueOnce({ data: "ok", error: null } as never)
    expect(await recordView("f1", { contactId: "c1" })).toBe("ok")
  })
  it("surfaces a database error instead of treating it as a refusal or an allow", async () => {
    rpc().mockResolvedValueOnce({ data: null, error: { message: "boom" } } as never)
    await expect(fileAccess("f1", { contactId: "c1" })).rejects.toThrow(/store_file_access failed: boom/)
  })
})

describe("staff actions", () => {
  const staffCalls: Array<[string, (a: never) => Promise<unknown>]> = [
    ["sendCheck", (a) => sendCheck(a, { fileId: "f", recipientClass: "tax_authority", recipient: {}, reason: "SS-4" })],
    ["recordSend", (a) => recordSend(a, { fileId: "f", recipientClass: "accountant", recipient: { email: "x@y.z" }, reason: "pkg", channel: "email" })],
    ["setPublished", (a) => setPublished(a, "f", true)],
    ["setFilingStatus", (a) => setFilingStatus(a, "f", "filed")],
    ["endMembership", (a) => endMembership(a, { accountId: "a", contactId: "c" })],
    ["reopenMembership", (a) => reopenMembership(a, { accountId: "a", contactId: "c" })],
    ["revokeStoreAccess", (a) => revokeStoreAccess(a, { accountId: "a", contactId: "c" })],
    ["restoreStoreAccess", (a) => restoreStoreAccess(a, { accountId: "a", contactId: "c" })],
  ]
  it.each(staffCalls)("%s refuses clients, partners, users with no role and no user at all", async (_n, call) => {
    for (const who of [client, partner, noRole, null]) {
      await expect(call(who as never)).rejects.toBeInstanceOf(StoreAccessDeniedError)
    }
    expect(rpc()).not.toHaveBeenCalled()
  })
  it("passes the staff member as the actor and the recipient as plain json", async () => {
    rpc().mockResolvedValueOnce({ data: { event_id: 42, code: "ok" }, error: null } as never)
    expect(await recordSend(team as never, { fileId: "f", recipientClass: "bank", recipient: { email: "kyc@bank.test" }, reason: "KYC", channel: "email" })).toBe(42)
    expect(rpc().mock.calls[0]).toEqual(["store_record_send", {
      p_file_id: "f", p_recipient_class: "bank", p_recipient: { contact_id: null, email: "kyc@bank.test" },
      p_reason: "KYC", p_actor: "staff-2", p_channel: "email",
    }])
    rpc().mockResolvedValueOnce({ data: { status: "ended" }, error: null } as never)
    await endMembership(admin as never, { accountId: "a", contactId: "c", reason: "left" })
    expect(rpc().mock.calls[1]).toEqual(["store_end_membership", { p_account_id: "a", p_contact_id: "c", p_actor: "staff-1", p_reason: "left" }])
  })
  it("a send outside the rules is recorded by the database and THEN raised (never lost, never silent)", async () => {
    rpc().mockResolvedValueOnce({ data: { event_id: 7, code: "personal_not_allowed" }, error: null } as never)
    const err = await recordSend(admin as never, { fileId: "f", recipientClass: "other", recipient: { email: "x@y.z" }, reason: "r", channel: "email" }).catch((e) => e)
    expect(err).toBeInstanceOf(StoreSendOutsideRulesError)
    expect(err).toMatchObject({ code: "personal_not_allowed", eventId: 7 })
  })
  it("reports a send check verdict", async () => {
    rpc().mockResolvedValueOnce({ data: "reason_required", error: null } as never)
    expect(await sendCheck(admin as never, { fileId: "f", recipientClass: "tax_authority", recipient: {} })).toEqual({ allowed: false, code: "reason_required" })
  })
})

describe("slice-3 migration shape", () => {
  const sql = readFileSync(join(process.cwd(), "scripts/migrations/20260925-1500-crm-store-s3-access.sql"), "utf8")
  it("revokes every new function from the web roles", () => {
    const fns = Array.from(sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)).map((m) => m[1])
    expect(fns.length).toBeGreaterThanOrEqual(13)
    for (const fn of fns) expect(sql, `${fn} must be revoked`).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`))
  })
  it("never sends email itself — the exit invitation is only queued", () => {
    expect(sql).not.toMatch(/net\.http|pg_net|gmail|send_email/i)
    expect(sql).toMatch(/store_exit_invitations/)
  })
  it("does not touch today's portal or staff screens (dark slice): links only gain nullable columns", () => {
    expect(sql).not.toMatch(/DELETE FROM public\.(account_contacts|members)/)
    expect(sql).not.toMatch(/ALTER TABLE public\.members/)
    for (const m of Array.from(sql.matchAll(/ALTER TABLE public\.account_contacts ([^;]+);/g))) {
      expect(m[1]).toMatch(/^ADD COLUMN IF NOT EXISTS \w+ (timestamptz|uuid)$/)
    }
  })
  it("fails loudly when the member-ownership-periods column is missing (no silent skip)", () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'CRM store S3 needs members\.end_date/)
    expect(sql).not.toMatch(/EXECUTE 'UPDATE public\.members/)
  })
  it("visibility reads stored state only — no signed-record override", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.store_file_self_visible"), sql.indexOf("FUNCTION public.store_file_client_visible"))
    expect(fn).toMatch(/f\.published/)
    expect(fn).not.toMatch(/signature_requests|esign_envelopes|stage/)
  })
})
