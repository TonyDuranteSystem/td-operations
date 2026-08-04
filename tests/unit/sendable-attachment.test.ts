import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The one resolver that decides what may be attached to an outbound email.
 *
 * What these pin:
 *  - a file posted in a conversation (public `assets` bucket) becomes attachable
 *    — the case Luca reported twice — and its BYTES are copied into the private
 *    bucket at prepare, so the frozen draft holds what the human approves rather
 *    than a pointer at something that can change underneath it;
 *  - the model still never names a location: it names a ref the server minted;
 *  - an untrusted host is refused (the SSRF boundary is not optional);
 *  - a mime type off a chat row is shape-checked before it can reach a header;
 *  - size refusals read like Gmail's limit, not an invented policy of ours.
 */

const uploadSpy = vi.hoisted(() => vi.fn())
const fetchedUrls = vi.hoisted(() => [] as string[])
const fetchBytes = vi.hoisted(() => ({ value: Buffer.from("hello world") }))

const removeSpy = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        upload: async (path: string, bytes: Buffer, opts: unknown) => {
          uploadSpy(path, bytes, opts)
          return { data: { path }, error: null }
        },
        remove: async (paths: string[]) => {
          removeSpy(paths)
          return { data: null, error: null }
        },
      }),
    },
  },
}))

vi.mock("@/lib/ai-agent/attachment-reader", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-agent/attachment-reader")>(
    "@/lib/ai-agent/attachment-reader",
  )
  return {
    ...actual,
    // The real fetcher's host allow-list is exercised by its own tests; here we
    // only need to know the resolver goes THROUGH it (and honours its refusal).
    fetchTrustedStorageBytes: async (ref: { id: string }) => {
      fetchedUrls.push(ref.id)
      if (!ref.id.includes("ydzipybqeebtpcvsbtvs.supabase.co")) throw new Error(`untrusted host`)
      return fetchBytes.value
    },
  }
})

import {
  discardCopies,
  materializeSendable,
  sendableFromChatRefs,
  sendableFromDocumentRows,
  documentRef,
  internalDocumentReason,
  attachableFilesPrompt,
  SendableRefusal,
  type SendableFile,
} from "@/lib/inbox/sendable-attachment"

const CAP = 18 * 1024 * 1024
const teamChatUrl =
  "https://ydzipybqeebtpcvsbtvs.supabase.co/storage/v1/object/public/assets/team-chat/e2816056-7e71-46ba-8306-675ffd33c5d6/d9f25bfd-f73d-457a-a68e-e3f1152dbf9c.pdf"

const chatFile: SendableFile = {
  ref: "f1",
  source: "chat_asset",
  locator: teamChatUrl,
  name: "EIN Letter (IRS) - Flowiz studio LLC.pdf",
  contentType: "application/pdf",
  size: 15_253,
  origin: "posted in this message",
}

beforeEach(() => {
  uploadSpy.mockClear()
  removeSpy.mockClear()
  fetchedUrls.length = 0
  fetchBytes.value = Buffer.from("hello world")
})

describe("materializeSendable — a file posted in a conversation", () => {
  it("copies it into the PRIVATE bucket and freezes that path (Luca's reported case)", async () => {
    const out = await materializeSendable(chatFile, CAP)
    expect(fetchedUrls).toEqual([teamChatUrl])
    // The frozen location is ours, in the shape the confirm path already accepts.
    expect(out.path).toMatch(/^worker-chat\/[0-9a-f-]{36}\.pdf$/)
    expect(uploadSpy).toHaveBeenCalledOnce()
    expect(out.name).toBe(chatFile.name)
    expect(out.origin).toBe("posted in this message")
  })

  it("records the ACTUAL byte length, not the size declared on the chat row", async () => {
    fetchBytes.value = Buffer.alloc(4321)
    const out = await materializeSendable(chatFile, CAP)
    expect(out.size).toBe(4321)
  })

  it("REFUSES a file from a host that is not our storage (the SSRF boundary holds)", async () => {
    const evil = { ...chatFile, locator: "https://attacker.example.com/x.pdf" }
    await expect(materializeSendable(evil, CAP)).rejects.toBeInstanceOf(SendableRefusal)
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it("SHAPE-CHECKS the mime type off the chat row before it can reach a MIME header", async () => {
    const poisoned = { ...chatFile, contentType: "application/pdf\r\nBcc: someone@else.com" }
    const out = await materializeSendable(poisoned, CAP)
    expect(out.content_type).toBe("application/octet-stream")
  })

  it("refuses an oversize file in Gmail's terms — and copies nothing", async () => {
    fetchBytes.value = Buffer.alloc(64)
    await expect(materializeSendable(chatFile, 32)).rejects.toThrow(/Gmail won't accept an email that big/)
    expect(uploadSpy).not.toHaveBeenCalled()
  })
})

describe("materializeSendable — a panel upload", () => {
  it("uses it in place (nothing is copied) — it is already ours and already private", async () => {
    const upload: SendableFile = {
      ref: "up1",
      source: "worker_upload",
      locator: "worker-chat/0f8fad5b-d9cb-469f-a165-70867728950e.pdf",
      name: "affidavit.pdf",
      size: 400,
    }
    const out = await materializeSendable(upload, CAP)
    expect(out.path).toBe(upload.locator)
    expect(uploadSpy).not.toHaveBeenCalled()
  })

  it("REFUSES a path outside the private bucket's own shape (no traversal, no other bucket)", async () => {
    const bad: SendableFile = {
      ref: "up1",
      source: "worker_upload",
      locator: "signed-documents/secret.pdf",
      name: "secret.pdf",
    }
    await expect(materializeSendable(bad, CAP)).rejects.toBeInstanceOf(SendableRefusal)
  })
})

describe("sendableFromChatRefs / attachableFilesPrompt", () => {
  it("mints sequential refs and can start after another surface's refs, so two sets never collide", () => {
    const files = sendableFromChatRefs(
      [{ id: "u1", name: "a.pdf" }, { id: "u2", name: "b.pdf" }],
      "posted in this client's chat",
      3,
    )
    expect(files.map((f) => f.ref)).toEqual(["f3", "f4"])
    expect(files.every((f) => f.source === "chat_asset")).toBe(true)
  })

  it("tells the worker the ref, the name and where the file came from — and never a URL", () => {
    const line = attachableFilesPrompt([chatFile])
    expect(line).toContain("f1 — EIN Letter (IRS) - Flowiz studio LLC.pdf (posted in this message)")
    expect(line).not.toContain("supabase.co")
  })

  it("says nothing at all when there is nothing to attach (no false capability)", () => {
    expect(attachableFilesPrompt([])).toBe("")
  })
})

describe("sendableFromDocumentRows — a document we hold on record", () => {
  const base = {
    id: "doc-1",
    file_name: "EIN Letter.pdf",
    mime_type: "application/pdf",
    account_id: "acct-A",
    owner_name: "Flowiz Studio LLC",
    // A client-safe stage for Company Formation, so no internal-only warning.
    service_type: "Company Formation",
    flow_stage: "EIN Received",
    portal_visible: false,
  }

  it("names the OWNER on the card — 'EIN Letter.pdf' is identical across every company we serve", () => {
    const [f] = sendableFromDocumentRows([base])
    expect(f.origin).toBe("on file for Flowiz Studio LLC")
    expect(f.source).toBe("document")
    // The model gets a ref; the document id stays server-side in the locator.
    expect(f.ref).toBe(documentRef("doc-1"))
    expect(f.locator).toBe("doc-1")
  })

  it("WARNS LOUDLY when the file belongs to a different client than the screen — and still offers it", () => {
    // Antonio, 2026-08-03: "let it through with a loud warning on the card."
    // Emailing one client's document to their own accountant is legitimate;
    // only the human can tell that apart from a mix-up.
    const [f] = sendableFromDocumentRows([base], { recipientAccountId: "acct-B" })
    expect(f.warning).toMatch(/belongs to Flowiz Studio LLC/)
    expect(f.warning).toMatch(/Check before you send/)
    expect(f.locator).toBe("doc-1") // offered, not withheld
  })

  it("does NOT warn when the file belongs to the client this screen is about", () => {
    const [f] = sendableFromDocumentRows([base], { recipientAccountId: "acct-A" })
    expect(f.warning).toBeUndefined()
  })

  it("cannot assert a mismatch off a client screen (a team channel) — and does not pretend to", () => {
    const [f] = sendableFromDocumentRows([base], {})
    expect(f.warning).toBeUndefined()
  })

  it("WARNS on an internal-only document — the signed SS-4 must never reach a client unnoticed", () => {
    // flow_stage 'Signed' is deliberately absent from the client-safe allowlist
    // for Company Formation: the signed SS-4 carries the responsible party's tax ID.
    const [f] = sendableFromDocumentRows([{ ...base, file_name: "SS-4 signed.pdf", flow_stage: "Signed" }])
    expect(f.warning).toMatch(/Internal document/)
  })

  it("treats an explicitly published document as client-safe", () => {
    const [f] = sendableFromDocumentRows([{ ...base, flow_stage: "Signed", portal_visible: true }])
    expect(f.warning).toBeUndefined()
  })

  it("stacks BOTH warnings when a file is internal AND another client's", () => {
    const [f] = sendableFromDocumentRows([{ ...base, flow_stage: "Signed" }], { recipientAccountId: "acct-B" })
    expect(f.warning).toMatch(/belongs to/)
    expect(f.warning).toMatch(/Internal document/)
  })

  it("derives the ref FROM THE DOCUMENT, so a re-offer is idempotent and two files can never share one", () => {
    // Positional numbering is what broke: the counter was computed from a list
    // that shrinks when a file is re-offered, so a third search in one turn could
    // mint an already-live ref — and resolution takes the FIRST match, so
    // "attach d3" would have frozen a different client's document than the one
    // the model was shown, carrying that file's warning and owner too.
    const first = sendableFromDocumentRows([base, { ...base, id: "doc-2" }])
    const reoffered = sendableFromDocumentRows([base])
    expect(first[0].ref).toBe(reoffered[0].ref)
    expect(first[0].ref).not.toBe(first[1].ref)
    expect(documentRef("doc-1")).toBe(first[0].ref)
  })

  it("SURVIVES the three-search sequence that produced the collision", () => {
    // 1) both of Acme's docs, 2) narrow to one (a re-offer), 3) a different
    // client's doc. Every live ref must still point at exactly one file.
    const round1 = sendableFromDocumentRows([base, { ...base, id: "doc-2" }])
    const round2 = sendableFromDocumentRows([base])
    const round3 = sendableFromDocumentRows([{ ...base, id: "doc-C", owner_name: "Beta LLC", account_id: "acct-B" }])
    const live = [...round1, ...round2, ...round3]
    const byRef = new Map<string, Set<string>>()
    for (const f of live) {
      if (!byRef.has(f.ref)) byRef.set(f.ref, new Set())
      byRef.get(f.ref)!.add(f.locator)
    }
    for (const [ref, locators] of byRef) expect(`${ref}:${locators.size}`).toBe(`${ref}:1`)
  })
})

describe("MORE THAN ONE FILE on one email", () => {
  it("offers several files at once, each with its own ref, and lists them all to the worker", () => {
    const files = [
      ...sendableFromChatRefs([{ id: "u1", name: "a.pdf" }, { id: "u2", name: "b.png" }], "posted in this thread"),
      ...sendableFromDocumentRows(
        [{ id: "doc-9", file_name: "Articles.pdf", owner_name: "Flowiz Studio LLC", service_type: "Company Formation", flow_stage: "Articles Received" }],
      ),
    ]
    expect(files.map((f) => f.ref)).toEqual(["f1", "f2", documentRef("doc-9")])
    // Every ref distinct — that is the property that matters when several files
    // ride one email.
    expect(new Set(files.map((f) => f.ref)).size).toBe(3)
    const line = attachableFilesPrompt(files)
    for (const name of ["a.pdf", "b.png", "Articles.pdf"]) expect(line).toContain(name)
    // It must know several refs are allowed on ONE email, or it attaches one and
    // narrates the rest.
    expect(line).toMatch(/several refs for several files/)
  })

  it("repeats a file's warning in the list, so the worker cannot attach a flagged file silently", () => {
    const [f] = sendableFromDocumentRows(
      [{ id: "doc-3", file_name: "SS-4 signed.pdf", document_type_name: "Form SS-4 (Signed)", owner_name: "ACME LLC" }],
    )
    expect(attachableFilesPrompt([f])).toMatch(/Internal document/)
  })
})

describe("which documents are actually held back from clients", () => {
  // THE RULE THIS REPLACED WAS BOTH TOO WIDE AND POINTED THE WRONG WAY. It asked
  // the PORTAL-visibility policy, which fails closed on a document with no flow
  // stage — and 4,847 of 4,929 real documents have no service delivery at all,
  // so it flagged 3,185 of them (65%) while never once catching the signed SS-4
  // (584 rows, every one with a null flow stage). A warning on two thirds of
  // everything is a warning nobody reads.
  const plain = { id: "d", file_name: "Bank letter.pdf", document_type_name: "Bank Statement", portal_visible: false }

  it("does NOT flag an ordinary document — the case 98% of our records are in", () => {
    expect(internalDocumentReason(plain)).toBeNull()
    expect(sendableFromDocumentRows([plain])[0].warning).toBeUndefined()
  })

  it("FLAGS the signed SS-4 — the document the rule exists for, which the old rule missed", () => {
    for (const name of ["Form SS-4", "Form SS-4 (Signed)", "SS-4", "SS-4 + Articles (IRS Package)"]) {
      expect(internalDocumentReason({ id: "d", document_type_name: name })).toMatch(/tax ID/)
    }
    // Also when only the filename carries it.
    expect(internalDocumentReason({ id: "d", file_name: "ss4 signed scan.pdf" })).toMatch(/tax ID/)
  })

  it("does not flag an EIN letter or Articles — what a bank actually asks the client for", () => {
    expect(internalDocumentReason({ id: "d", document_type_name: "EIN Letter (IRS)" })).toBeNull()
    expect(internalDocumentReason({ id: "d", file_name: "Articles of Organization.pdf" })).toBeNull()
  })

  it("still applies the curated rule to a REAL flow document (the 39 rows it was written for)", () => {
    expect(
      internalDocumentReason({ id: "d", file_name: "draft.pdf", service_type: "Tax Return", flow_stage: "Tax Return Prepared" }),
    ).toMatch(/internal working document/)
    expect(
      internalDocumentReason({ id: "d", file_name: "filed.pdf", service_type: "Tax Return", flow_stage: "Filed with IRS" }),
    ).toBeNull()
  })

  it("STILL flags an SS-4 that is marked client-visible — the flag is more likely a data defect than a decision", () => {
    // 178 of the 704 SS-4 documents on record carry portal_visible=true, which
    // contradicts Antonio's standing rule that the SS-4 never goes to a client.
    // The warning exists for exactly the case where the record is wrong, and it
    // blocks nothing — so a named-internal document is flagged regardless.
    expect(internalDocumentReason({ id: "d", document_type_name: "Form SS-4", portal_visible: true })).toMatch(/tax ID/)
  })

  it("a published FLOW document is not flagged — there, publishing IS the deliberate decision", () => {
    expect(
      internalDocumentReason({
        id: "d",
        file_name: "draft.pdf",
        service_type: "Tax Return",
        flow_stage: "Tax Return Prepared",
        portal_visible: true,
      }),
    ).toBeNull()
  })
})

describe("discardCopies — cleaning up after a draft that will never be sent", () => {
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"

  it("deletes OUR copies", async () => {
    await discardCopies([
      { path: `worker-chat/${uuid}.pdf`, copied: true },
      { path: `worker-chat/${uuid}.png`, copied: true },
    ])
    expect(removeSpy).toHaveBeenCalledOnce()
    expect(removeSpy.mock.calls[0][0]).toHaveLength(2)
  })

  it("NEVER deletes a panel upload — that object belongs to the staff member's own screen", async () => {
    // Deleting it would pull the file out from under the panel they are still
    // looking at, and they never asked us to remove anything.
    await discardCopies([{ path: `worker-chat/${uuid}.pdf`, copied: false }])
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it("ignores anything whose path is not a private-bucket path, and never throws", async () => {
    await expect(
      discardCopies([{ path: "signed-documents/secret.pdf", copied: true }, { copied: true }, null as never]),
    ).resolves.toBeUndefined()
    expect(removeSpy).not.toHaveBeenCalled()
  })
})
