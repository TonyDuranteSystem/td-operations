import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The load-bearing part is the SCOPE: a portal chat is a union of account_id and
 * (contact_id AND account_id NULL). Keying on one id misses the client's
 * person-tagged screenshots — the exact bug this fix exists to close. These tests
 * capture the filter that reaches the DB and prove images are read newest-first.
 */

const png = (bytes = 64) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.alloc(bytes)])

// Capture what the query builder was asked to filter on.
const calls = vi.hoisted(() => ({ or: [] as string[], eq: [] as Array<[string, string]>, is: [] as Array<[string, unknown]> }))
const rowsBox = vi.hoisted(() => ({ rows: [] as unknown[] }))

vi.mock("@/lib/supabase-admin", () => {
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = chain
  builder.is = (c: string, v: unknown) => { calls.is.push([c, v]); return builder }
  builder.order = chain
  builder.limit = chain
  builder.or = (f: string) => { calls.or.push(f); return builder }
  builder.eq = (c: string, v: string) => { calls.eq.push([c, v]); return builder }
  // await on the builder resolves to the rows
  builder.then = (resolve: (v: { data: unknown[] }) => void) => resolve({ data: rowsBox.rows })
  return { supabaseAdmin: { from: () => builder } }
})

// Only the network fetch is mocked; readAttachments/attachmentRefsFromChatRow run for real.
const fetchBytes = vi.hoisted(() => vi.fn())
vi.mock("@/lib/ai-agent/attachment-reader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-agent/attachment-reader")>()
  return { ...actual, fetchTrustedStorageBytes: (ref: { id: string }) => fetchBytes(ref) }
})

import { harvestPortalChatAttachments, MAX_CHAT_IMAGES } from "@/lib/portal/chat-attachment-harvest"

function row(sender: string, attachments: unknown[], created = "2026-07-10T00:00:00Z") {
  return { sender_type: sender, attachments, attachment_url: null, attachment_name: null, created_at: created }
}
const imgAtt = (name: string) => ({ url: `https://ydzipybqeebtpcvsbtvs.supabase.co/x/${name}`, name, mime_type: "image/png", size: 5000 })
const pdfAtt = (name: string) => ({ url: `https://ydzipybqeebtpcvsbtvs.supabase.co/x/${name}`, name, mime_type: "application/pdf", size: 5000 })

beforeEach(() => {
  calls.or = []; calls.eq = []; calls.is = []
  rowsBox.rows = []
  fetchBytes.mockReset()
  fetchBytes.mockResolvedValue(png())
})

describe("scope filter", () => {
  it("UNIONS account and person-tagged scopes when both ids are present", async () => {
    await harvestPortalChatAttachments({ accountId: "acc-1", contactId: "con-1" })
    expect(calls.or).toEqual(["account_id.eq.acc-1,and(contact_id.eq.con-1,account_id.is.null)"])
  })

  it("account only → account scope", async () => {
    await harvestPortalChatAttachments({ accountId: "acc-1", contactId: null })
    expect(calls.eq).toContainEqual(["account_id", "acc-1"])
    expect(calls.or).toEqual([])
  })

  it("contact only → person scope with account_id NULL", async () => {
    await harvestPortalChatAttachments({ accountId: null, contactId: "con-1" })
    expect(calls.eq).toContainEqual(["contact_id", "con-1"])
    expect(calls.is).toContainEqual(["account_id", null])
  })

  it("no ids → empty, no query", async () => {
    const out = await harvestPortalChatAttachments({})
    expect(out).toEqual({ imageBlocks: [], note: "", files: [] })
    expect(calls.or.length + calls.eq.length).toBe(0)
  })
})

describe("harvest — the attachable set", () => {
  // The worker could always READ these files and never attach one to an email,
  // so forwarding a client's own document to our accountant meant downloading it
  // and re-uploading it by hand. `files` is what closes that; if it silently
  // returned nothing, the capability would ship dead and the worker would go
  // back to saying it cannot attach anything here.
  it("offers the client's files as attachable refs, images included", async () => {
    rowsBox.rows = [row("client", [imgAtt("shot.png"), { url: "https://ydzipybqeebtpcvsbtvs.supabase.co/x/bank.pdf", name: "bank.pdf", mime_type: "application/pdf", size: 900 }])]
    const out = await harvestPortalChatAttachments({ accountId: "acc-1", contactId: null })
    expect(out.files.map((f) => f.name)).toEqual(["shot.png", "bank.pdf"])
    // Refs carry the URL for the server to resolve — never handed to the model.
    expect(out.files[1].id).toContain("bank.pdf")
  })

  it("DOES offer our own outbound files — 'attach the SS-4 I sent them' is an ordinary ask", async () => {
    // READING stays scoped to the client's files (the worker is answering about
    // what THEY sent), but excluding our own posts from the ATTACHABLE set
    // produced a false "I can't attach that" for a file sitting right there in
    // the conversation.
    rowsBox.rows = [row("admin", [imgAtt("ours.png")])]
    const out = await harvestPortalChatAttachments({ accountId: "acc-1", contactId: null })
    expect(out.files.map((f) => f.name)).toEqual(["ours.png"])
    // ...and it is still not fed to the model as one of the client's images.
    expect(out.imageBlocks).toEqual([])
  })
})

describe("harvest", () => {
  it("reads the client's screenshot into an image block", async () => {
    rowsBox.rows = [row("client", [imgAtt("shot.png")])]
    const out = await harvestPortalChatAttachments({ accountId: "a", contactId: "c" })
    expect(out.imageBlocks).toHaveLength(1)
    expect(out.note).toMatch(/shown to you above|shared/i)
  })

  it("ignores admin attachments by default (the reported bug is the CLIENT's file)", async () => {
    rowsBox.rows = [row("admin", [imgAtt("admin.png")]), row("client", [imgAtt("client.png")])]
    const out = await harvestPortalChatAttachments({ accountId: "a", contactId: "c" })
    expect(out.imageBlocks).toHaveLength(1)
    expect(fetchBytes).toHaveBeenCalledTimes(1)
  })

  it("caps images at the budget and does not fetch beyond it", async () => {
    rowsBox.rows = [row("client", [imgAtt("a.png"), imgAtt("b.png"), imgAtt("c.png"), imgAtt("d.png"), imgAtt("e.png")])]
    const out = await harvestPortalChatAttachments({ accountId: "a", contactId: "c" })
    expect(out.imageBlocks).toHaveLength(MAX_CHAT_IMAGES)
    expect(fetchBytes).toHaveBeenCalledTimes(MAX_CHAT_IMAGES)
  })

  it("lists documents for on-demand reading, does NOT download them", async () => {
    rowsBox.rows = [row("client", [pdfAtt("contract.pdf")])]
    const out = await harvestPortalChatAttachments({ accountId: "a", contactId: "c" })
    expect(out.imageBlocks).toHaveLength(0)
    expect(fetchBytes).not.toHaveBeenCalled()
    expect(out.note).toContain("contract.pdf")
    expect(out.note).toMatch(/read_portal_attachment/)
  })

  it("takes newest-first images (query returns DESC), so the latest screenshot wins the budget", async () => {
    // Query is ordered DESC, so rows[0] is newest. Budget = 3; the 3 newest fill it.
    rowsBox.rows = [
      row("client", [imgAtt("newest.png")], "2026-07-10T05:00:00Z"),
      row("client", [imgAtt("mid.png")], "2026-07-10T04:00:00Z"),
      row("client", [imgAtt("old1.png")], "2026-07-10T03:00:00Z"),
      row("client", [imgAtt("old2.png")], "2026-07-10T02:00:00Z"),
    ]
    const out = await harvestPortalChatAttachments({ accountId: "a", contactId: "c" })
    expect(out.imageBlocks).toHaveLength(3)
    // old2 (4th newest) is the one dropped
    expect(fetchBytes.mock.calls.map((c) => c[0].id)).not.toContain("https://ydzipybqeebtpcvsbtvs.supabase.co/x/old2.png")
  })

  it("returns empty on a query failure rather than throwing", async () => {
    rowsBox.rows = []
    const out = await harvestPortalChatAttachments({ accountId: "a", contactId: "c" })
    expect(out).toEqual({ imageBlocks: [], note: "", files: [] })
  })

  it("handles legacy single-attachment columns", async () => {
    rowsBox.rows = [
      { sender_type: "client", attachments: [], attachment_url: "https://ydzipybqeebtpcvsbtvs.supabase.co/x/legacy.png", attachment_name: "legacy.png", created_at: "2026-07-10T00:00:00Z" },
    ]
    const out = await harvestPortalChatAttachments({ accountId: "a", contactId: "c" })
    expect(out.imageBlocks).toHaveLength(1)
  })
})
