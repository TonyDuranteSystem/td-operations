import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The Inbox worker prepares an email-with-attachment; a human Confirm sends it.
 * These tests pin the locks: only the staff's this-turn upload is attachable,
 * only thread recipients, size-guarded, and the model can never make it SEND —
 * prepare freezes, it never dispatches.
 */

const inserted = vi.hoisted(() => ({ id: "prep-1" }))
const insertSpy = vi.hoisted(() => vi.fn())

const updateSpy = vi.hoisted(() => vi.fn())
const eqSpy = vi.hoisted(() => vi.fn())
const neqSpy = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase-admin", () => {
  const b: Record<string, unknown> = {}
  b.from = () => b
  b.insert = (row: unknown) => { insertSpy(row); return b }
  b.select = () => b
  b.update = (patch: unknown) => { updateSpy(patch); return b }
  b.eq = (col: unknown, val: unknown) => { eqSpy(col, val); return b }
  b.neq = (col: unknown, val: unknown) => { neqSpy(col, val); return b }
  b.single = async () => ({ data: inserted, error: null })
  // The supersede runs as a bare awaited chain (update→eq→eq), so the builder
  // must be thenable for it to resolve.
  b.then = (resolve: (v: unknown) => void) => Promise.resolve({ error: null }).then(resolve)
  return { supabaseAdmin: b }
})

import { prepareWorkerEmailSend, MAX_OUTBOUND_ATTACHMENT_BYTES } from "@/lib/inbox/worker-email-send"

const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"
const goodPath = `worker-chat/${uuid}.pdf`

const base = {
  threadUuid: "t-1",
  gmailThreadId: "gt-1",
  mailbox: "support@tonydurante.us",
  replyToMessageId: "m-1",
  to: "client@acme.com",
  subject: "Re: your LLC",
  body: "Here is the affidavit.",
  allowedRecipients: ["client@acme.com", "support@tonydurante.us"],
  actor: "luca@tonydurante.us",
}
const sendable = [{ ref: "up1", path: goodPath, name: "affidavit.pdf", contentType: "application/pdf", size: 400_000 }]

beforeEach(() => { insertSpy.mockClear(); updateSpy.mockClear(); eqSpy.mockClear(); neqSpy.mockClear() })

describe("prepareWorkerEmailSend — supersede", () => {
  it("CANCELS this actor's earlier pending EMAIL drafts — after the new one is safely frozen", async () => {
    // Drafting is iterative ("no, say we need his numbers first"). Each pass freezes
    // a row. In Team Chat the older card is a PERMANENT chat message that stays
    // clickable, so without this the superseded email could be dispatched half an
    // hour later, contradicting the one actually sent. Found by the 4th council pass.
    //
    // TWO PROPERTIES CHANGED 2026-07-31 when the portal kind landed, both from review:
    //
    // 1. SCOPED BY KIND. Antonio's flagship flow is doing BOTH on one email thread —
    //    reply to the bank AND message the client on the portal. An unscoped cancel
    //    makes that impossible: the portal freeze silently kills the pending email,
    //    no card ever refuses, and the reply to the bank is simply never sent.
    // 2. RUNS AFTER THE INSERT, never before, and never touches the row just frozen.
    //    Superseding first means a prepare that then fails validation has already
    //    destroyed a draft the staff member spent several turns agreeing, leaving
    //    nothing pending and no card to explain where it went.
    await prepareWorkerEmailSend({ ...base, attachRefs: [], sendable })
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }))
    expect(eqSpy).toHaveBeenCalledWith("thread_uuid", "t-1")
    expect(eqSpy).toHaveBeenCalledWith("status", "pending")
    expect(eqSpy).toHaveBeenCalledWith("actor", "luca@tonydurante.us")
    expect(eqSpy).toHaveBeenCalledWith("kind", "email")
    // Never cancels the row it just froze.
    expect(neqSpy).toHaveBeenCalledWith("id", "prep-1")
  })

  it("writes kind='email' on the frozen row — the column has NO default on purpose", async () => {
    // A default of 'email' would make any insert that forgets the discriminator send a
    // real email to a real person; the column is NOT NULL with no default so a
    // forgetful insert raises instead. That only holds if this path always writes it.
    await prepareWorkerEmailSend({ ...base, attachRefs: [], sendable })
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ kind: "email" }))
  })

  it("still freezes the new draft after superseding", async () => {
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: [], sendable })
    expect(r.ok).toBe(true)
    expect(insertSpy).toHaveBeenCalledOnce()
  })
})

describe("prepareWorkerEmailSend", () => {
  it("prepares (freezes) a send and returns a confirmation naming file + recipient", async () => {
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable })
    expect(r.ok).toBe(true)
    expect(r.ok && r.message).toMatch(/client@acme\.com/)
    expect(r.ok && r.message).toMatch(/affidavit\.pdf/)
    expect(r.ok && r.message).toMatch(/Confirm/i)
    // It FROZE a row — it did not send.
    expect(insertSpy).toHaveBeenCalledOnce()
    expect(insertSpy.mock.calls[0][0]).toMatchObject({ status: "pending", to_address: "client@acme.com" })
  })

  it("REFUSES a recipient not on the thread", async () => {
    const r = await prepareWorkerEmailSend({ ...base, to: "evil@attacker.com", attachRefs: ["up1"], sendable })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toMatch(/not on this email thread/)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("REFUSES a ref the staff didn't upload this turn (model can't attach anything else)", async () => {
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up99"], sendable })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toMatch(/not a file you attached/)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  // CONTRACT CHANGED 2026-07-28. This used to assert that a prepare with no
  // attachments is refused — which is precisely why only attachment sends ever got
  // a frozen, confirmable payload, and a plain email fell back to the path where
  // Confirm re-ran the model and sent a draft nobody had read. A text-only prepare
  // is now the ordinary case. What still must NOT be possible is asking for a file
  // that isn't yours — covered by the next two tests, which are unchanged.
  it("ALLOWS a text-only prepare (no attachments) and freezes the payload", async () => {
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: [], sendable })
    expect(r.ok).toBe(true)
    expect(insertSpy).toHaveBeenCalled()
    // The frozen row must carry the message itself, not just the recipient.
    const row = insertSpy.mock.calls[0][0]
    expect(row.to_address).toBe(base.to)
    expect(row.body).toBe(base.body)
    expect(row.status).toBe("pending")
    expect(row.attachments).toEqual([])
  })

  // The human confirmation is the gate for an address the pin refused, so the
  // frozen row must hold the address the human will be shown — unchanged.
  it("freezes a PROPOSED recipient without consulting the allow-list", async () => {
    const r = await prepareWorkerEmailSend({
      ...base,
      to: "someone-not-on-the-thread@elsewhere.com",
      attachRefs: [],
      sendable,
      allowedRecipients: ["only@thread.com"],
      proposedRecipient: true,
    })
    expect(r.ok).toBe(true)
    expect(insertSpy.mock.calls[0][0].to_address).toBe("someone-not-on-the-thread@elsewhere.com")
  })

  it("still REFUSES an off-allow-list recipient when it is NOT flagged as proposed", async () => {
    const r = await prepareWorkerEmailSend({
      ...base,
      to: "someone-not-on-the-thread@elsewhere.com",
      attachRefs: [],
      sendable,
      allowedRecipients: ["only@thread.com"],
    })
    expect(r.ok).toBe(false)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("REFUSES an upload whose path is not a valid worker-upload path (no path traversal / other bucket)", async () => {
    const bad = [{ ref: "up1", path: "signed-documents/secret.pdf", name: "x.pdf", size: 10 }]
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable: bad })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toMatch(/can't be attached/)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("REFUSES over the outbound size limit with a clean message", async () => {
    const big = [{ ref: "up1", path: goodPath, name: "huge.pdf", size: MAX_OUTBOUND_ATTACHMENT_BYTES + 1 }]
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable: big })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toMatch(/Too large to email/)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("fails closed when the allow-list is empty (thread unreadable)", async () => {
    const r = await prepareWorkerEmailSend({ ...base, allowedRecipients: [], attachRefs: ["up1"], sendable })
    expect(r.ok).toBe(false)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("freezes only the resolved attachment's path/name/size — never bytes", async () => {
    await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable })
    const row = insertSpy.mock.calls[0][0] as { attachments: Array<Record<string, unknown>> }
    expect(row.attachments[0]).toEqual({ path: goodPath, name: "affidavit.pdf", content_type: "application/pdf", size: 400_000 })
  })
})
