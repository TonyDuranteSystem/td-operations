import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The Inbox worker prepares an email-with-attachment; a human Confirm sends it.
 * These tests pin the locks: only the staff's this-turn upload is attachable,
 * only thread recipients, size-guarded, and the model can never make it SEND —
 * prepare freezes, it never dispatches.
 */

const inserted = vi.hoisted(() => ({ id: "prep-1" }))
const insertSpy = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase-admin", () => {
  const b: Record<string, unknown> = {}
  b.from = () => b
  b.insert = (row: unknown) => { insertSpy(row); return b }
  b.select = () => b
  b.single = async () => ({ data: inserted, error: null })
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

beforeEach(() => insertSpy.mockClear())

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

  it("REFUSES when there are no attach refs (nothing to attach)", async () => {
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: [], sendable })
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
