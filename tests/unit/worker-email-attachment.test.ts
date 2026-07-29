import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * read_email_attachment is the worker's only route to a Gmail attachment, and
 * the ONLY thing standing between the Portal Chats panel (which has no mailbox
 * gate) and antonio@'s inbox is the server-pinned allow-list. These tests exist
 * to make that pin impossible to remove by accident.
 */

const getGmailAttachment = vi.fn()
vi.mock("@/lib/gmail", () => ({ getGmailAttachment }))

import {
  readEmailAttachmentForWorker,
  executeWorkerTool,
  READ_EMAIL_ATTACHMENT_TOOL,
  type PinnedEmailAttachment,
} from "@/lib/ai-agent/worker-tools"

const pinned: PinnedEmailAttachment[] = [
  {
    ref: "att1",
    messageId: "msg-support-1",
    attachmentId: "a-1",
    mailbox: "support@tonydurante.us",
    name: "affidavit.csv",
    mimetype: "text/csv",
    size: 40,
  },
]

beforeEach(() => {
  getGmailAttachment.mockReset()
  getGmailAttachment.mockResolvedValue({ data: Buffer.from("col1,col2\n1,2", "utf8"), size: 13 })
})

describe("readEmailAttachmentForWorker", () => {
  it("reads an attachment named by a pinned ref", async () => {
    const out = await readEmailAttachmentForWorker({ ref: "att1" }, pinned)
    expect(out).toContain("col1,col2")
    expect(getGmailAttachment).toHaveBeenCalledWith("msg-support-1", "a-1", "support@tonydurante.us")
  })

  it("REFUSES a ref the server did not pin — the model cannot reach another message", async () => {
    const out = await readEmailAttachmentForWorker({ ref: "att99" }, pinned)
    expect(out).toMatch(/not an attachment on this email/)
    expect(getGmailAttachment).not.toHaveBeenCalled()
  })

  it("refuses everything when nothing was pinned (e.g. the Portal Chats panel)", async () => {
    const out = await readEmailAttachmentForWorker({ ref: "att1" }, null)
    expect(out).toMatch(/no email attachments available/i)
    expect(getGmailAttachment).not.toHaveBeenCalled()
  })

  it("ignores model-supplied message/attachment ids entirely", async () => {
    // A model that tries to smuggle a target must be ignored: only `ref` is read.
    const out = await readEmailAttachmentForWorker(
      { ref: "att1", message_id: "antonio-secret", attachment_id: "evil", mailbox: "antonio.durante@tonydurante.us" },
      pinned,
    )
    expect(out).toContain("col1,col2")
    expect(getGmailAttachment).toHaveBeenCalledWith("msg-support-1", "a-1", "support@tonydurante.us")
  })

  it("requires a ref", async () => {
    expect(await readEmailAttachmentForWorker({}, pinned)).toMatch(/ref is required/)
  })

  it("lists what IS available when the ref is wrong, so the worker can retry", async () => {
    const out = await readEmailAttachmentForWorker({ ref: "nope" }, pinned)
    expect(out).toContain("att1 (affidavit.csv)")
  })

  it("reports a download failure instead of inventing contents", async () => {
    getGmailAttachment.mockRejectedValueOnce(new Error("Gmail attachment 404"))
    const out = await readEmailAttachmentForWorker({ ref: "att1" }, pinned)
    expect(out).toMatch(/Couldn't read "affidavit.csv"/)
    expect(out).toContain("404")
  })

  it("tells the worker to look at an image rather than extracting it", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])
    getGmailAttachment.mockResolvedValueOnce({ data: png, size: png.length })
    const out = await readEmailAttachmentForWorker({ ref: "att1" }, pinned)
    expect(out).toMatch(/already shown to you/)
  })

  it("admits a scanned PDF has no extractable text", async () => {
    getGmailAttachment.mockResolvedValueOnce({ data: Buffer.from("%PDF-1.4 nope", "utf8"), size: 13 })
    const scanned: PinnedEmailAttachment[] = [{ ...pinned[0], name: "scan.pdf", mimetype: "application/pdf" }]
    const out = await readEmailAttachmentForWorker({ ref: "att1" }, scanned)
    expect(out).toMatch(/scanned PDF with no text layer/)
    expect(out).not.toMatch(/limit/) // no phantom "limit reached" — there is no limit here
  })
})

describe("executeWorkerTool — read_email_attachment gating", () => {
  it("refuses the tool when it was not made available for this call", async () => {
    const out = await executeWorkerTool("read_email_attachment", { ref: "att1" }, new Set())
    expect(out).toMatch(/not permitted in this worker call/)
    expect(getGmailAttachment).not.toHaveBeenCalled()
  })

  it("refuses when available but nothing was pinned (defense-in-depth)", async () => {
    const out = await executeWorkerTool("read_email_attachment", { ref: "att1" }, new Set(["read_email_attachment"]))
    expect(out).toMatch(/no email attachments available/i)
    expect(getGmailAttachment).not.toHaveBeenCalled()
  })

  it("resolves the ref against the pinned list carried on the send context", async () => {
    const out = await executeWorkerTool(
      "read_email_attachment",
      { ref: "att1" },
      new Set(["read_email_attachment"]),
      null,
      null,
      { pinnedEmailAttachments: pinned },
    )
    expect(out).toContain("col1,col2")
  })
})

describe("READ_EMAIL_ATTACHMENT_TOOL", () => {
  it("exposes NOTHING the model could aim — no message id, no mailbox, no attachment id", () => {
    // `ref` resolves against the server-pinned allow-list for THIS call, and
    // `offset` (2026-07-29, continue-reading for long files) is only a position
    // WITHIN that same pinned file. The security property is that no parameter
    // names a message, mailbox or attachment — pinned here as an exact list so a
    // future addition has to argue its case in this test.
    expect(Object.keys(READ_EMAIL_ATTACHMENT_TOOL.parameters.properties).sort()).toEqual(["offset", "ref"])
    expect(READ_EMAIL_ATTACHMENT_TOOL.parameters.required).toEqual(["ref"])
  })
})
