/** Send back to the client, tested against a fake database and mailer. */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Op = { table: string; kind: "select" | "update" | "insert"; payload: Record<string, unknown> | null; filters: [string, string, unknown][] }

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  row: null as Record<string, unknown> | null,
  replacements: [] as { id: string; status: string }[],
  claim: { data: { id: "old" }, error: null } as { data: unknown; error: unknown },
  insert: { data: { id: "new-id", token: "tok_new" }, error: null } as { data: unknown; error: unknown },
  gmail: vi.fn(),
}))

vi.mock("@/lib/gmail", () => ({ gmailPost: (...a: unknown[]) => h.gmail(...a) }))
vi.mock("@/lib/supabase-admin", () => {
  const run = (op: Op) => {
    h.ops.push(op)
    if (op.kind === "insert") return h.insert
    if (op.kind === "update") return op.payload && "returned_note" in op.payload ? { data: null, error: null } : op.payload?.return_note ? h.claim : { data: null, error: null }
    // reading the application, or the earlier send-back's replacements
    if (op.filters.some((f) => f[1] === "replaces_id")) return { data: h.replacements, error: null }
    return { data: h.row, error: null }
  }
  const builder = (table: string) => {
    const op: Op = { table, kind: "select", payload: null, filters: [] }
    const b: Record<string, unknown> = {}
    const chain = (name: string) => (...args: unknown[]) => { op.filters.push([name, String(args[0]), args[1]]); return b }
    b.select = () => b
    b.update = (p: Record<string, unknown>) => { op.kind = "update"; op.payload = p; return b }
    b.insert = (p: Record<string, unknown>) => { op.kind = "insert"; op.payload = p; return b }
    for (const f of ["eq", "is", "not", "lt", "in", "or", "neq"]) b[f] = chain(f)
    b.maybeSingle = () => Promise.resolve(run(op))
    b.single = () => Promise.resolve(run(op))
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run(op)).then(res, rej)
    return b
  }
  return { supabaseAdmin: { from: builder } }
})

import { sendBackToClient } from "@/lib/bofa-intake/send-back"

const ROW = { id: "old", label: "Max Scale", partner_name: "Max Scale", status: "completed", email_status: null, reviewed_at: null, returned_at: null, form_data: { full_name: "Jordan Smith", email: "jordan@example.com" } }

beforeEach(() => {
  h.ops = []
  h.row = { ...ROW }
  h.replacements = []
  h.claim = { data: { id: "old" }, error: null }
  h.insert = { data: { id: "new-id", token: "tok_new" }, error: null }
  h.gmail.mockReset()
  h.gmail.mockResolvedValue({})
})

describe("Send back to the client", () => {
  it("needs a note before anything happens", async () => {
    const r = await sendBackToClient("old", "luca@x.co", "   ")
    expect(r.ok).toBe(false)
    expect(h.ops).toHaveLength(0)
    expect(h.gmail).not.toHaveBeenCalled()
  })

  it("marks the old one sent back, makes a NEW link for the same partner carrying the note, and emails the client once", async () => {
    const r = await sendBackToClient("old", "luca@x.co", "Passport photo is cut off")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.emailed).toBe(true)
      expect(r.emailedTo).toBe("jordan@example.com")
      expect(r.url).toContain("tok_new")
    }
    const claim = h.ops.find((o) => o.kind === "update")
    expect(claim?.payload?.return_note).toBe("Passport photo is cut off")
    expect(claim?.payload?.returned_by).toBe("luca@x.co")
    const created = h.ops.find((o) => o.kind === "insert")
    expect(created?.payload).toMatchObject({ label: "Max Scale", partner_name: "Max Scale", replaces_id: "old", staff_note: "Passport photo is cut off", recipients: [] })
    expect(h.gmail).toHaveBeenCalledTimes(1)
    const mime = Buffer.from((h.gmail.mock.calls[0][1] as { raw: string }).raw, "base64url").toString("utf8")
    expect(mime).toContain("To: jordan@example.com")
  })

  it("works AFTER the application was already submitted to the bank contact", async () => {
    h.row = { ...ROW, reviewed_at: "x", email_status: "sent" }
    const r = await sendBackToClient("old", "luca@x.co", "The bank asked for a residential address")
    expect(r.ok).toBe(true)
  })

  it("refuses a second send-back while the client has a live link", async () => {
    h.row = { ...ROW, returned_at: "2026-11-02T10:00:00Z" }
    h.replacements = [{ id: "n", status: "pending" }]
    const r = await sendBackToClient("old", "luca@x.co", "again")
    expect(r.ok).toBe(false)
    expect(h.ops.some((o) => o.kind === "update")).toBe(false)
  })

  it("allows it again when the earlier new link was cancelled", async () => {
    h.row = { ...ROW, returned_at: "2026-11-02T10:00:00Z" }
    h.replacements = [{ id: "n", status: "revoked" }]
    const r = await sendBackToClient("old", "luca@x.co", "again")
    expect(r.ok).toBe(true)
  })

  it("refuses an application that was never submitted, or has no usable email", async () => {
    h.row = { ...ROW, status: "opened" }
    expect((await sendBackToClient("old", "l", "x")).ok).toBe(false)
    h.row = { ...ROW, form_data: { full_name: "J", email: "nope" } }
    expect((await sendBackToClient("old", "l", "x")).ok).toBe(false)
    expect(h.gmail).not.toHaveBeenCalled()
  })

  it("a lost race (someone else sent it back first) makes no link and sends nothing", async () => {
    h.claim = { data: null, error: null }
    const r = await sendBackToClient("old", "l", "x")
    expect(r.ok).toBe(false)
    expect(h.ops.some((o) => o.kind === "insert")).toBe(false)
    expect(h.gmail).not.toHaveBeenCalled()
  })

  it("if the new link cannot be made, the old application is put back exactly as it was", async () => {
    h.insert = { data: null, error: { message: "db" } }
    const r = await sendBackToClient("old", "l", "x")
    expect(r.ok).toBe(false)
    const undo = h.ops.filter((o) => o.kind === "update").pop()
    expect(undo?.payload).toMatchObject({ returned_at: null, returned_by: null, return_note: null })
    expect(h.gmail).not.toHaveBeenCalled()
  })

  it("rolling back a failed SECOND send-back keeps the first one's note and author", async () => {
    h.row = { ...ROW, returned_at: "2026-11-02T10:00:00Z", returned_by: "first@x.co", return_note: "first note" }
    h.replacements = [{ id: "n", status: "revoked" }]
    h.insert = { data: null, error: { message: "db" } }
    const r = await sendBackToClient("old", "second@x.co", "second note")
    expect(r.ok).toBe(false)
    const undo = h.ops.filter((o) => o.kind === "update").pop()
    expect(undo?.payload).toMatchObject({ returned_at: "2026-11-02T10:00:00Z", returned_by: "first@x.co", return_note: "first note" })
  })

  it("\"Create link only\": makes the new link and marks the old one sent back, but sends NO email, even without a usable email address", async () => {
    h.row = { ...ROW, form_data: { full_name: "Jordan Smith" } } // no email on file
    const r = await sendBackToClient("old", "luca@x.co", "Please upload a full-page passport photo", { email: false })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.linkOnly).toBe(true)
      expect(r.emailed).toBe(false)
      expect(r.url).toContain("tok_new")
    }
    expect(h.gmail).not.toHaveBeenCalled()
    expect(h.ops.find((o) => o.kind === "update")?.payload?.return_note).toBe("Please upload a full-page passport photo")
    expect(h.ops.find((o) => o.kind === "insert")?.payload).toMatchObject({ replaces_id: "old", staff_note: "Please upload a full-page passport photo" })
  })

  it("\"Create link only\" still needs the note (the client reads it on the form)", async () => {
    const r = await sendBackToClient("old", "l", "  ", { email: false })
    expect(r.ok).toBe(false)
    expect(h.ops).toHaveLength(0)
  })

  it("the ordinary send-back still refuses an application with no usable email address", async () => {
    h.row = { ...ROW, form_data: { full_name: "J", email: "nope" } }
    expect((await sendBackToClient("old", "l", "x")).ok).toBe(false)
  })

  it("if only the email fails, the link still exists and is handed back so staff can send it by hand", async () => {
    h.gmail.mockRejectedValue(new Error("gmail down"))
    const r = await sendBackToClient("old", "l", "x")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.emailed).toBe(false)
      expect(r.url).toContain("tok_new")
      expect(r.emailError).toBe("gmail down")
    }
  })
})
