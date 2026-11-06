/**
 * gmail_read_thread (lib/ai-agent/tools.ts) — the worker's own thread reader.
 *
 * It used to return only text, so a worker that double-checked "does this email
 * have an attachment?" with it got nothing back and answered "no attachments"
 * about a photo the client had attached (found in the Inbox Worker QA, dev job
 * b9c074df). It now lists the files the sender attached — names, types, sizes —
 * the same set staff see as chips, without the pictures the body itself shows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { gmailGet } = vi.hoisted(() => ({ gmailGet: vi.fn() }))

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => ({}) } }))
// Only the network call is mocked: extractAttachments and the embedded-image rule run for real.
vi.mock("@/lib/gmail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail")>()
  return { ...actual, gmailGet }
})

import { executeTool } from "@/lib/ai-agent/tools"

const b64 = (s: string) => Buffer.from(s).toString("base64url")
const plain = (s: string) => ({ mimeType: "text/plain", body: { data: b64(s) } })
const html = (s: string) => ({ mimeType: "text/html", body: { data: b64(s) } })
const file = (filename: string, mimeType: string, size: number, attachmentId: string, contentId?: string) => ({
  filename,
  mimeType,
  headers: contentId ? [{ name: "Content-ID", value: `<${contentId}>` }] : [],
  body: { size, attachmentId },
})
const message = (id: string, parts: unknown[]) => ({
  id,
  snippet: "",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "client@example.com" },
      { name: "To", value: "support@tonydurante.us" },
      { name: "Subject", value: "Invoices" },
      { name: "Date", value: "Fri, 6 Nov 2026 11:51:41 +0400" },
    ],
    parts,
  },
})

async function read(messages: unknown[]) {
  gmailGet.mockResolvedValue({ id: "t1", messages })
  return JSON.parse(await executeTool("gmail_read_thread", { thread_id: "t1" })) as {
    messages: Array<{ id: string; body: string; attachments?: Array<Record<string, unknown>> }>
  }
}

beforeEach(() => gmailGet.mockReset())

describe("gmail_read_thread attachments", () => {
  it("lists a photo the client ATTACHED in Gmail (it carries an f_ Content-ID) — the bug shape", async () => {
    const out = await read([
      message("m1", [plain("see attached"), html("<p>see attached</p>"), file("WhatsApp Image.jpeg", "image/jpeg", 103_204, "att1", "f_abc")]),
    ])
    expect(out.messages[0].attachments).toEqual([
      { filename: "WhatsApp Image.jpeg", mimeType: "image/jpeg", size: 103_204 },
    ])
  })

  it("leaves out a signature logo the HTML body displays, keeps the real file next to it", async () => {
    const out = await read([
      message("m1", [
        html('<p>Best</p><img src="cid:logo@x">'),
        file("logo.png", "image/png", 60_000, "logo1", "logo@x"),
        file("contract.pdf", "application/pdf", 900_000, "pdf1"),
      ]),
    ])
    expect(out.messages[0].attachments?.map((a) => a.filename)).toEqual(["contract.pdf"])
  })

  it("returns ONLY name, type and size — never the long Gmail attachment id", async () => {
    const out = await read([message("m1", [plain("x"), file("a.pdf", "application/pdf", 10, "very-long-gmail-attachment-token")])])
    expect(Object.keys(out.messages[0].attachments![0]).sort()).toEqual(["filename", "mimeType", "size"])
  })

  it("adds no attachments key to a message without any (the old shape is unchanged)", async () => {
    const out = await read([message("m1", [plain("just text")])])
    expect("attachments" in out.messages[0]).toBe(false)
    expect(out.messages[0].body).toBe("just text")
  })

  it("reports attachments per message across the thread", async () => {
    const out = await read([
      message("m1", [plain("hi"), file("first.pdf", "application/pdf", 5, "a1")]),
      message("m2", [plain("reply")]),
      message("m3", [plain("again"), file("shot.png", "image/png", 9, "a3", "f_zzz")]),
    ])
    expect(out.messages.map((m) => m.attachments?.map((a) => a.filename) ?? [])).toEqual([["first.pdf"], [], ["shot.png"]])
  })
})
