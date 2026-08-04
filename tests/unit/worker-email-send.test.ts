import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The Inbox worker prepares an email-with-attachment; a human Confirm sends it.
 * These tests pin the locks: only the staff's this-turn upload is attachable,
 * only thread recipients, size-guarded, and the model can never make it SEND —
 * prepare freezes, it never dispatches.
 */

const uuidConst = vi.hoisted(() => "0f8fad5b-d9cb-469f-a165-70867728950e")
/** What storage reports the object's REAL size to be; null = stat unavailable. */
const statSize = vi.hoisted(() => ({ value: 400_000 as number | null }))
const inserted = vi.hoisted(() => ({ id: "prep-1" }))
const insertSpy = vi.hoisted(() => vi.fn())
const removeSpy = vi.hoisted(() => vi.fn())
const uploadedPaths = vi.hoisted(() => [] as string[])
/** Rows the supersede UPDATE reports as cancelled. */
const supersededRows = vi.hoisted(() => ({ value: [] as Array<{ attachments: Array<{ path: string; copied: boolean }> }> }))
/** Force the freeze INSERT to fail, to exercise that orphan path. */
const insertFails = vi.hoisted(() => ({ value: false }))

const updateSpy = vi.hoisted(() => vi.fn())
const eqSpy = vi.hoisted(() => vi.fn())
const neqSpy = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase-admin", () => {
  const b: Record<string, unknown> = {}
  b.from = () => b
  // Attachments are now MATERIALIZED at prepare (real bytes in the private
  // bucket), so the resolver stats the object and — for a file posted in a
  // conversation — copies it in. Both go through storage.
  b.storage = {
    from: () => ({
      list: async () => ({
        data: statSize.value === null ? [] : [{ name: `${uuidConst}.pdf`, metadata: { size: statSize.value } }],
        error: null,
      }),
      upload: async (path: string) => { uploadedPaths.push(path); return { data: { path }, error: null } },
      remove: async (paths: string[]) => { removeSpy(paths); return { data: null, error: null } },
    }),
  }
  b.insert = (row: unknown) => { insertSpy(row); return b }
  b.select = () => b
  b.update = (patch: unknown) => { updateSpy(patch); return b }
  b.eq = (col: unknown, val: unknown) => { eqSpy(col, val); return b }
  b.neq = (col: unknown, val: unknown) => { neqSpy(col, val); return b }
  b.single = async () => (insertFails.value ? { data: null, error: { message: "insert boom" } } : { data: inserted, error: null })
  // The supersede/cancel UPDATEs end in .select("attachments"); the builder is
  // thenable, so this is what those awaits resolve to.
  b.select = () => b
  // The supersede runs as a bare awaited chain (update→eq→eq), so the builder
  // must be thenable for it to resolve.
  b.then = (resolve: (v: unknown) => void) =>
    Promise.resolve({ data: supersededRows.value, error: null }).then(resolve)
  return { supabaseAdmin: b }
})

vi.mock("@/lib/ai-agent/attachment-reader", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-agent/attachment-reader")>(
    "@/lib/ai-agent/attachment-reader",
  )
  return {
    ...actual,
    // Our own storage host resolves; anything else is refused, which is how the
    // cleanup test gets one successful copy followed by one failure.
    fetchTrustedStorageBytes: async (ref: { id: string }) => {
      if (!ref.id.includes("ydzipybqeebtpcvsbtvs.supabase.co")) throw new Error("untrusted host")
      return Buffer.from("copied bytes")
    },
  }
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
const sendable = [
  {
    ref: "up1",
    source: "worker_upload" as const,
    locator: goodPath,
    name: "affidavit.pdf",
    contentType: "application/pdf",
    size: 400_000,
    origin: "you uploaded this just now",
  },
]

beforeEach(() => {
  insertSpy.mockClear(); updateSpy.mockClear(); eqSpy.mockClear(); neqSpy.mockClear(); removeSpy.mockClear()
  uploadedPaths.length = 0
  supersededRows.value = []
  insertFails.value = false
  statSize.value = 400_000
})

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
    expect(r.ok === false && r.message).toMatch(/not a file you can attach here/)
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
    const bad = [{ ref: "up1", source: "worker_upload" as const, locator: "signed-documents/secret.pdf", name: "x.pdf", size: 10 }]
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable: bad })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toMatch(/can't be attached/)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("REFUSES over the outbound size limit with a clean message", async () => {
    statSize.value = MAX_OUTBOUND_ATTACHMENT_BYTES + 1
    const big = [{ ref: "up1", source: "worker_upload" as const, locator: goodPath, name: "huge.pdf", size: MAX_OUTBOUND_ATTACHMENT_BYTES + 1 }]
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable: big })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toMatch(/Gmail won't accept an email that big/)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("fails closed when the allow-list is empty (thread unreadable)", async () => {
    const r = await prepareWorkerEmailSend({ ...base, allowedRecipients: [], attachRefs: ["up1"], sendable })
    expect(r.ok).toBe(false)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("REFUSES on the DECLARED size when storage can't be stat'd — a stat failure must not turn an oversize file into an unchecked one", async () => {
    statSize.value = null
    const big = [{ ref: "up1", source: "worker_upload" as const, locator: goodPath, name: "huge.pdf", size: MAX_OUTBOUND_ATTACHMENT_BYTES + 1 }]
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable: big })
    expect(r.ok).toBe(false)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("freezes the REAL size, not the browser-declared one (the card must not print a wrong MB)", async () => {
    statSize.value = 9_100_000
    const lying = [{ ref: "up1", source: "worker_upload" as const, locator: goodPath, name: "affidavit.pdf", size: 12 }]
    await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable: lying })
    const row = insertSpy.mock.calls[0][0] as { attachments: Array<Record<string, unknown>> }
    expect(row.attachments[0].size).toBe(9_100_000)
  })

  it("attaches SEVERAL files to one email — each frozen in its own right, in the order asked for", async () => {
    // "attach these two and send it" is ordinary; the card renders one tile per
    // file, so the frozen row has to carry every one of them.
    const two = [
      ...sendable,
      {
        ref: "up2",
        source: "worker_upload" as const,
        locator: `worker-chat/${uuid}.pdf`,
        name: "ein.pdf",
        contentType: "application/pdf",
        size: 120_000,
        origin: "posted in this thread by Luca",
      },
    ]
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up1", "up2"], sendable: two })
    expect(r.ok).toBe(true)
    const row = insertSpy.mock.calls[0][0] as { attachments: Array<Record<string, unknown>> }
    expect(row.attachments).toHaveLength(2)
    expect(row.attachments.map((a) => a.name)).toEqual(["affidavit.pdf", "ein.pdf"])
    // Both are named back to the staff member, not just the first.
    expect(r.ok && r.message).toMatch(/affidavit\.pdf/)
    expect(r.ok && r.message).toMatch(/ein\.pdf/)
  })

  it("carries each file's WARNING onto the frozen row — a warning that stops at the resolver is not a warning", async () => {
    const flagged = [{ ...sendable[0], warning: "⚠️ Internal document — we do not normally share this one with clients." }]
    await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable: flagged })
    const row = insertSpy.mock.calls[0][0] as { attachments: Array<Record<string, unknown>> }
    expect(row.attachments[0].warning).toMatch(/Internal document/)
  })

  it("REFUSES more files than one email can carry, and says how to proceed", async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ref: `up${i + 1}`,
      source: "worker_upload" as const,
      locator: goodPath,
      name: `f${i + 1}.pdf`,
      size: 10,
    }))
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: many.map((m) => m.ref), sendable: many })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toMatch(/Send them in two emails/)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("freezes the attachment's location/name/type/size AND its provenance — never bytes", async () => {
    // `origin` is what makes the Confirm card checkable: it turns "EIN Letter.pdf"
    // (which looks identical whoever it belongs to) into "EIN Letter.pdf, posted in
    // this thread by Luca". Dropping it here would leave the card rendering a bare
    // filename again while the code around it claims otherwise.
    await prepareWorkerEmailSend({ ...base, attachRefs: ["up1"], sendable })
    const row = insertSpy.mock.calls[0][0] as { attachments: Array<Record<string, unknown>> }
    expect(row.attachments[0]).toEqual({
      path: goodPath,
      name: "affidavit.pdf",
      content_type: "application/pdf",
      size: 400_000,
      origin: "you uploaded this just now",
      warning: undefined,
      owner_label: undefined,
      // A panel upload is the staff member's OWN object — never marked as our
      // copy, so cleanup can never delete it out from under their panel.
      copied: false,
    })
  })
})

describe("prepareWorkerEmailSend — mixed clients, and cleaning up after ourselves", () => {
  // "good" resolves (the mocked fetcher returns bytes); "bad" is refused.
  const chat = (name: string) => ({
    ref: name,
    source: "chat_asset" as const,
    locator: name === "good"
      ? "https://ydzipybqeebtpcvsbtvs.supabase.co/storage/v1/object/public/assets/team-chat/x/y.pdf"
      : "https://attacker.example.com/bad.pdf",
    name: `${name}.pdf`,
  })

  it("FLAGS an email that mixes two clients' files — on EVERY file, and with both names", async () => {
    // The per-file mismatch check needs a client pinned to the screen, and the
    // Inbox has none — which is exactly the surface where "reply to the
    // accountant with the client's document" happens. Comparing the owners of
    // what is actually going out works everywhere, and is the only check that
    // can see a mix (each file on its own is perfectly fine).
    // ownerKEY is what identifies the client — a company and the person behind
    // it have different names and are the same client, so the check compares
    // keys and only uses the labels for the sentence.
    const owned = (ref: string, owner: string, key: string) => ({
      ref,
      source: "worker_upload" as const,
      locator: goodPath,
      name: `${ref}.pdf`,
      size: 10,
      ownerLabel: owner,
      ownerKey: key,
    })
    const r = await prepareWorkerEmailSend({
      ...base,
      attachRefs: ["up1", "up2"],
      sendable: [owned("up1", "Acme LLC", "acct-A"), owned("up2", "Beta LLC", "acct-B")],
    })
    expect(r.ok).toBe(true)
    const row = insertSpy.mock.calls[0][0] as { attachments: Array<{ warning?: string }> }
    for (const a of row.attachments) {
      expect(a.warning).toMatch(/different clients/)
      expect(a.warning).toMatch(/Acme LLC/)
      expect(a.warning).toMatch(/Beta LLC/)
    }
  })

  it("does NOT flag the company's document plus its own owner's document — same client, different names", async () => {
    const owned = (ref: string, key: string) => ({
      ref,
      source: "worker_upload" as const,
      locator: goodPath,
      name: `${ref}.pdf`,
      size: 10,
      ownerLabel: key === "acct-A" ? "Acme LLC" : "Mario Rossi",
      ownerKey: key,
    })
    // THE EVERYDAY CASE: the company's document and its own owner's document.
    // Different NAMES, same client — this must not be flagged as a mix.
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up1", "up2"], sendable: [owned("up1", "acct-A"), owned("up2", "acct-A")] })
    expect(r.ok).toBe(true)
    const row = insertSpy.mock.calls[0][0] as { attachments: Array<{ warning?: string }> }
    expect(row.attachments.every((a) => !a.warning)).toBe(true)
  })

  it("DELETES the copies it already made when a later file in the same email fails", async () => {
    // Without this, "attach these three" where the third is unreadable leaves
    // the first two copies of client documents in the bucket with no row on
    // earth referencing them. The FIRST file here is a chat file, so it really
    // is copied — the earlier version of this test used a panel upload, which is
    // never copied, so it asserted nothing and passed with the feature removed.
    const r = await prepareWorkerEmailSend({
      ...base,
      attachRefs: ["good", "bad"],
      sendable: [chat("good"), chat("bad")],
    })
    expect(r.ok).toBe(false)
    // The copy made for the first file was removed.
    expect(removeSpy).toHaveBeenCalled()
    expect(uploadedPaths).toHaveLength(1)
    expect(removeSpy.mock.calls.at(-1)?.[0]).toEqual([uploadedPaths[0]])
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("NEVER deletes a panel upload when a later file fails — that object is the staff member's own", async () => {
    const upload = { ref: "up1", source: "worker_upload" as const, locator: goodPath, name: "ok.pdf", size: 10 }
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["up1", "bad"], sendable: [upload, chat("bad")] })
    expect(r.ok).toBe(false)
    expect(removeSpy).not.toHaveBeenCalled()
  })
})

describe("copies are discarded on EVERY path where a draft dies", () => {
  // The hunter's audit: these call sites existed but nothing tested them —
  // deleting any of the discard loops left the suite green. Each case below
  // fails if its loop is removed.
  const chatFile = { ref: "c1", source: "chat_asset" as const, locator: "https://ydzipybqeebtpcvsbtvs.supabase.co/storage/v1/object/public/assets/team-chat/a/b.pdf", name: "client-doc.pdf", contentType: "application/pdf" }

  it("SUPERSEDE: redrafting drops the earlier draft's copies", async () => {
    // The supersede UPDATE returns the rows it cancelled; each one's copies go.
    supersededRows.value = [{ attachments: [{ path: `worker-chat/${uuid}.pdf`, copied: true }] }]
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["c1"], sendable: [chatFile] })
    expect(r.ok).toBe(true)
    expect(removeSpy.mock.calls.flatMap((c) => c[0])).toContain(`worker-chat/${uuid}.pdf`)
  })

  it("SUPERSEDE: a superseded draft's PANEL UPLOAD is never deleted", async () => {
    supersededRows.value = [{ attachments: [{ path: `worker-chat/${uuid}.pdf`, copied: false }] }]
    await prepareWorkerEmailSend({ ...base, attachRefs: [], sendable: [] })
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it("INSERT FAILURE: a copy made for a row that never existed is dropped", async () => {
    insertFails.value = true
    const r = await prepareWorkerEmailSend({ ...base, attachRefs: ["c1"], sendable: [chatFile] })
    expect(r.ok).toBe(false)
    expect(uploadedPaths).toHaveLength(1)
    expect(removeSpy.mock.calls.flatMap((c) => c[0])).toContain(uploadedPaths[0])
  })
})
