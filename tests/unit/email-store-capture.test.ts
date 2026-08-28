import { describe, it, expect } from "vitest"
import {
  withGmailRetry,
  gmailErrorStatus,
  planAttachments,
  captureMessageContent,
  type CaptureDeps,
} from "@/lib/email-store/capture"

const noSleep = () => Promise.resolve()

describe("withGmailRetry", () => {
  it("retries a 429 then succeeds", async () => {
    let calls = 0
    const out = await withGmailRetry(async () => {
      calls++
      if (calls < 3) throw new Error("Gmail API 429: rate limit")
      return "ok"
    }, { sleep: noSleep })
    expect(out).toBe("ok")
    expect(calls).toBe(3)
  })

  it("retries 5xx", async () => {
    let calls = 0
    await withGmailRetry(async () => { calls++; if (calls < 2) throw new Error("Gmail API 503: unavailable"); return 1 }, { sleep: noSleep })
    expect(calls).toBe(2)
  })

  it("does NOT retry a 404 (non-retryable) — rethrows immediately", async () => {
    let calls = 0
    await expect(withGmailRetry(async () => { calls++; throw new Error("Gmail API 404: not found") }, { sleep: noSleep }))
      .rejects.toThrow("404")
    expect(calls).toBe(1)
  })

  it("gives up after exhausting retries and rethrows", async () => {
    let calls = 0
    await expect(withGmailRetry(async () => { calls++; throw new Error("Gmail API 429: x") }, { retries: 2, sleep: noSleep }))
      .rejects.toThrow("429")
    expect(calls).toBe(3)
  })

  it("parses status from attachment errors too", () => {
    expect(gmailErrorStatus(new Error("Gmail attachment 429: x"))).toBe(429)
    expect(gmailErrorStatus(new Error("some other error"))).toBe(null)
  })

  it("applies half-jitter to backoff (no lockstep retries)", async () => {
    const sleeps: number[] = []
    let calls = 0
    await withGmailRetry(
      async () => { calls++; if (calls < 2) throw new Error("Gmail API 429: x"); return 1 },
      { baseDelayMs: 1000, sleep: async (ms) => { sleeps.push(ms) }, rand: () => 0.5 },
    )
    // attempt 0: backoff=1000 → 500 + 0.5*500 = 750 (not the bare 1000 → jittered)
    expect(sleeps).toEqual([750])
  })
})

describe("planAttachments", () => {
  const payload = {
    headers: [],
    mimeType: "multipart/mixed",
    parts: [
      { filename: "passport.pdf", mimeType: "application/pdf", body: { attachmentId: "att-1", size: 1000 }, headers: [] },
      // inline image: has Content-ID header, image mime, attachmentId, no filename
      { filename: "", mimeType: "image/png", body: { attachmentId: "att-2", size: 50 }, headers: [{ name: "Content-ID", value: "<logo@x>" }] },
    ],
  } as any

  it("plans one spec per attachment id, opaque paths, no filename leaked in path", () => {
    const specs = planAttachments(payload, "support", "msg-9")
    expect(specs).toHaveLength(2)
    const pdf = specs.find((s) => s.gmail_attachment_id === "att-1")!
    expect(pdf.filename).toBe("passport.pdf")
    expect(pdf.is_inline).toBe(false)
    expect(pdf.storage_path).toMatch(/^support\/msg-9\/att\/[0-9a-f]{32}$/)
    expect(pdf.storage_path).not.toContain("passport")
  })

  it("marks inline images with their content id", () => {
    const specs = planAttachments(payload, "support", "msg-9")
    const img = specs.find((s) => s.gmail_attachment_id === "att-2")!
    expect(img.is_inline).toBe(true)
    expect(img.content_id).toBe("logo@x")
  })
})

function makeDeps(over: Partial<CaptureDeps> = {}): { deps: CaptureDeps; log: string[]; content: any[] } {
  const log: string[] = []
  const content: any[] = []
  const deps: CaptureDeps = {
    gmailUser: "support@tonydurante.us",
    now: () => "2026-08-01T00:00:00Z",
    getStatus: async () => null,
    gmailGet: async (endpoint, params) => {
      log.push(`get:${params?.format}`)
      return {
        id: "msg-1", threadId: "t-1", internalDate: "1",
        payload: { headers: [], mimeType: "multipart/mixed", parts: [
          { filename: "", mimeType: "text/html", body: { data: Buffer.from("<p>hi</p>").toString("base64url") }, headers: [] },
          { filename: "a.pdf", mimeType: "application/pdf", body: { attachmentId: "att-1", size: 3 }, headers: [] },
        ] },
      }
    },
    getAttachment: async () => { log.push("att"); return { data: Buffer.from("PDF"), size: 3 } },
    putObject: async (path) => { log.push(`put:${path.includes("/att/") ? "attachment" : "body"}`) },
    upsertAttachment: async () => { log.push("row:att") },
    upsertContent: async (row) => { log.push(`content:${row.capture_status}`); content.push(row) },
    markError: async (_m, _id, _t, msg) => { log.push(`error:${msg}`) },
    ...over,
  }
  return { deps, log, content }
}

describe("captureMessageContent", () => {
  it("stores raw + attachments and writes capture_status=complete LAST", async () => {
    const { deps, log, content } = makeDeps()
    const res = await captureMessageContent({ mailbox: "support", messageId: "msg-1", threadId: "t-1" }, deps)
    expect(res).toEqual({ status: "complete", attachments: 1 })
    // completeness row is the LAST write, after body + attachment bytes
    expect(log.indexOf("content:complete")).toBe(log.length - 1)
    expect(log).toContain("put:body")
    expect(log).toContain("put:attachment")
    expect(content[0].capture_status).toBe("complete")
    expect(content[0].attachment_count).toBe(1)
    // real MIME-derived flag persisted, not discarded (2026-08-27 fix)
    expect(content[0].is_html).toBe(true)
  })

  it("persists is_html=false for a genuine plain-text message", async () => {
    const { deps, content } = makeDeps({
      gmailGet: async () => ({
        id: "msg-2", threadId: "t-2", internalDate: "1",
        payload: { headers: [], mimeType: "text/plain", body: { data: Buffer.from("hi there").toString("base64url") } },
      }),
    })
    await captureMessageContent({ mailbox: "support", messageId: "msg-2", threadId: "t-2" }, deps)
    expect(content[0].is_html).toBe(false)
  })

  it("is insert-once: a message already complete is skipped with no Gmail calls", async () => {
    const { deps, log } = makeDeps({ getStatus: async () => "complete" })
    const res = await captureMessageContent({ mailbox: "support", messageId: "msg-1", threadId: "t-1" }, deps)
    expect(res).toEqual({ status: "skipped" })
    expect(log).toEqual([])
  })

  it("marks error (never complete) when a Gmail fetch fails durably", async () => {
    const { deps, log, content } = makeDeps({
      gmailGet: async () => { throw new Error("Gmail API 404: gone") },
    })
    const res = await captureMessageContent({ mailbox: "support", messageId: "msg-1", threadId: "t-1" }, deps)
    expect(res.status).toBe("error")
    expect(log.some((l) => l.startsWith("error:"))).toBe(true)
    expect(content).toHaveLength(0) // never wrote a completeness row
  })
})
