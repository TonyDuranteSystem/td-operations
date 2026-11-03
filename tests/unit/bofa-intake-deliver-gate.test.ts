/**
 * The review gate, tested against a fake database: nothing goes out unless the application is Reviewed, not sent back, and
 * the person confirmed the address that is actually saved. (Antonio 2026-11-02: "we will submit it after we review it".)
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Op = { table: string; kind: "select" | "update" | "insert"; payload: Record<string, unknown> | null; filters: [string, string, unknown][] }

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  settings: [] as { key: string; value: unknown }[],
  settingsError: false,
  claims: [] as { data: unknown; error: unknown }[],
  rowForWhy: null as unknown,
  recordFailures: 0,
  gmail: vi.fn(),
  fileBytes: "pdf-bytes" as string | number | null, // a string = those bytes; a number = that many bytes; null = unreadable
  described: null as null | { name: string; contentType: string }, // what Storage says the file really is (null = same as its row)
}))

vi.mock("@/lib/gmail", () => ({ gmailPost: (...a: unknown[]) => h.gmail(...a) }))
vi.mock("@/lib/bofa-intake/files", () => ({
  readSubmissionFile: async () => (h.fileBytes === null ? null : typeof h.fileBytes === "number" ? Buffer.alloc(h.fileBytes) : Buffer.from(h.fileBytes)),
  signedUrlForSubmissionFile: async () => "https://signed.example/file",
  describeSubmissionFile: async (f: { name: string }) => h.described ?? { name: f.name, contentType: "application/pdf" },
}))
vi.mock("@/lib/supabase-admin", () => {
  const run = (op: Op) => {
    h.ops.push(op)
    if (op.table === "app_settings") return h.settingsError ? { data: null, error: { message: "boom" } } : { data: h.settings, error: null }
    if (op.kind === "update" && op.payload && op.payload.email_status === "sending") return h.claims.shift() ?? { data: null, error: null }
    if (op.kind === "update" && op.payload && op.payload.email_status === "sent" && h.recordFailures > 0) { h.recordFailures--; return { data: null, error: { message: "db blip" } } }
    if (op.kind === "select") return { data: h.rowForWhy, error: null }
    return { data: null, error: null }
  }
  const builder = (table: string) => {
    const op: Op = { table, kind: "select", payload: null, filters: [] }
    const b: Record<string, unknown> = {}
    const chain = (name: string) => (...args: unknown[]) => { op.filters.push([name, String(args[0]), args[1]]); return b }
    b.select = () => b
    b.update = (p: Record<string, unknown>) => { op.kind = "update"; op.payload = p; return b }
    for (const f of ["eq", "is", "not", "lt", "in", "or", "neq"]) b[f] = chain(f)
    b.maybeSingle = () => Promise.resolve(run(op))
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run(op)).then(res, rej)
    return b
  }
  return { supabaseAdmin: { from: builder } }
})

import { deliverSubmission } from "@/lib/bofa-intake/deliver"
import { SEND_UNCONFIRMED_PREFIX, sendMayHaveGoneOut } from "@/lib/bofa-intake/review-state"

const SETTINGS = [{ key: "bofa_submit_to", value: { emails: ["sekureye22@gmail.com"], changed_by: "a", changed_at: "t" } }]
const CLAIMED = { data: { form_data: { full_name: "Jordan Smith", company_name: "Northwind LLC", shipping_city: "Seminole" }, files: [{ key: "passport", name: "p.pdf", path: "t/passport/x" }] }, error: null }
const claimOps = () => h.ops.filter((o) => o.table === "bofa_intake_requests" && o.kind === "update" && o.payload?.email_status === "sending")
const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8")
const IPHONE = { data: { form_data: { full_name: "Jordan Smith", company_name: "Northwind LLC" }, files: [{ key: "passport", name: "IMG_4521.HEIC", path: "t/passport/x", store_file_id: "sf1" }] }, error: null }
/** The attachments a mail program would show: [{ type, name }] — the file names are RFC 2047 encoded in the message. */
const attachments = (mime: string) => {
  const found: { type: string; name: string }[] = []
  const re = /Content-Type: ([^;\r\n]+); name="=\?utf-8\?B\?([^?]+)\?="/g
  let m: RegExpExecArray | null
  while ((m = re.exec(mime)) !== null) found.push({ type: m[1], name: Buffer.from(m[2], "base64").toString("utf8") })
  return found
}
/** The HTML body of the message (base64 inside the MIME). */
const htmlOf = (mime: string) => {
  const part = /Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--bofa_/.exec(mime)
  return part ? Buffer.from(part[1].replace(/\r\n/g, ""), "base64").toString("utf8") : ""
}

beforeEach(() => {
  h.fileBytes = "pdf-bytes"
  h.described = null
  h.ops = []
  h.settings = SETTINGS
  h.settingsError = false
  h.claims = []
  h.rowForWhy = null
  h.recordFailures = 0
  h.gmail.mockReset()
  h.gmail.mockResolvedValue({})
})

describe("Submit to the bank contact", () => {
  it("sends nothing when the saved address cannot be read", async () => {
    h.settingsError = true
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r.ok).toBe(false)
    expect(h.gmail).not.toHaveBeenCalled()
    expect(claimOps()).toHaveLength(0)
  })

  it("sends nothing when no submit address is set", async () => {
    h.settings = []
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: [] })
    expect(r.ok).toBe(false)
    expect(h.gmail).not.toHaveBeenCalled()
    expect(claimOps()).toHaveLength(0)
  })

  it("sends nothing when the address changed after the confirm box was opened", async () => {
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["someone-else@x.co"] })
    expect(r.ok).toBe(false)
    expect("error" in r && r.error).toContain("changed")
    expect(h.gmail).not.toHaveBeenCalled()
    expect(claimOps()).toHaveLength(0)
  })

  it("refuses an application that was not marked Reviewed, and every claim attempt requires Reviewed and not-sent-back", async () => {
    h.rowForWhy = { status: "completed", email_status: null, reviewed_at: null, returned_at: null }
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r).toEqual({ ok: false, error: "Mark it Reviewed first." })
    expect(h.gmail).not.toHaveBeenCalled()
    const claims = claimOps()
    expect(claims.length).toBeGreaterThanOrEqual(2)
    for (const c of claims) {
      expect(c.filters).toContainEqual(["not", "reviewed_at", "is"])
      expect(c.filters).toContainEqual(["is", "returned_at", null])
      expect(c.filters).toContainEqual(["eq", "status", "completed"])
    }
  })

  it("tells the person when it was sent back, or already submitted", async () => {
    h.rowForWhy = { status: "completed", email_status: null, reviewed_at: "x", returned_at: "y" }
    const back = await deliverSubmission("id1", { by: "l", confirmTo: ["sekureye22@gmail.com"] })
    expect("error" in back && back.error).toContain("sent back")
    h.ops = []
    h.rowForWhy = { status: "completed", email_status: "sent", reviewed_at: "x", returned_at: null }
    const done = await deliverSubmission("id1", { by: "l", confirmTo: ["sekureye22@gmail.com"] })
    expect("error" in done && done.error).toContain("already")
    expect(h.gmail).not.toHaveBeenCalled()
  })

  it("on the happy path sends ONE email to the saved address, records who sent it and where it went", async () => {
    h.claims = [CLAIMED]
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["SEKUREYE22@gmail.com"] })
    expect(r).toEqual({ ok: true, sentTo: ["sekureye22@gmail.com"] })
    expect(h.gmail).toHaveBeenCalledTimes(1)
    const mime = decode((h.gmail.mock.calls[0][1] as { raw: string }).raw)
    expect(mime).toContain("To: sekureye22@gmail.com")
    expect(mime).toMatch(/Subject: =\?utf-8\?B\?/)
    const claim = claimOps()[0]
    expect(claim.payload?.sent_by).toBe("luca@x.co")
    const record = h.ops.find((o) => o.kind === "update" && o.payload?.email_status === "sent")
    expect(record?.payload?.sent_to).toEqual(["sekureye22@gmail.com"])
  })

  it("if the final write fails after the email went out, it is tried once more (so the row does not look unsent)", async () => {
    h.claims = [CLAIMED]
    h.recordFailures = 1
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r.ok).toBe(true)
    expect(h.gmail).toHaveBeenCalledTimes(1) // never emailed twice
    expect(h.ops.filter((o) => o.kind === "update" && o.payload?.email_status === "sent")).toHaveLength(2)
  })

  it("Submit is also the retry: a failed send is claimed again and goes out", async () => {
    h.claims = [{ data: null, error: null }, CLAIMED]
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r.ok).toBe(true)
    expect(h.gmail).toHaveBeenCalledTimes(1)
    const claims = claimOps()
    expect(claims[0].filters).toContainEqual(["is", "email_status", null])
    expect(claims[1].filters).toContainEqual(["eq", "email_status", "failed"])
  })

  it("a failed email is recorded as failed (so Submit can be pressed again) and reported", async () => {
    h.claims = [CLAIMED]
    h.gmail.mockRejectedValue(new Error("gmail down"))
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r.ok).toBe(false)
    expect(h.ops.some((o) => o.kind === "update" && o.payload?.email_status === "failed")).toBe(true)
  })
})

describe("a failure Gmail never confirmed is not reported as 'did not go through'", () => {
  it("an error AFTER the hand-off to Gmail began is saved with the warning first, so the page asks for a Sent-mailbox check", async () => {
    h.claims = [CLAIMED]
    h.gmail.mockRejectedValue(new Error("fetch failed"))
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r).toEqual({ ok: false, error: `${SEND_UNCONFIRMED_PREFIX}fetch failed` })
    const failed = h.ops.find((o) => o.kind === "update" && o.payload?.email_status === "failed")
    expect(failed?.payload?.email_error).toBe(`${SEND_UNCONFIRMED_PREFIX}fetch failed`)
    // and the very rule the staff page uses reads that saved row as "may have gone out"
    expect(sendMayHaveGoneOut({ status: "completed", email_status: "failed", reviewed_at: "x", email_error: failed?.payload?.email_error as string })).toBe(true)
  })

  it("a clear refusal from Gmail (an answer in the 400s) is a plain failure too: Gmail looked and said no, so nothing went out", async () => {
    h.claims = [CLAIMED]
    h.gmail.mockRejectedValue(new Error("Gmail API 400: Request payload size exceeds the limit"))
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r).toEqual({ ok: false, error: "Gmail API 400: Request payload size exceeds the limit" })
    const failed = h.ops.find((o) => o.kind === "update" && o.payload?.email_status === "failed")
    expect(String(failed?.payload?.email_error)).not.toContain("Gmail did not confirm")
    expect(sendMayHaveGoneOut({ status: "completed", email_status: "failed", reviewed_at: "x", email_error: failed?.payload?.email_error as string })).toBe(false)
  })

  it("a server error from Gmail (5xx) is NOT a refusal: it may have been processed, so it carries the warning", async () => {
    h.claims = [CLAIMED]
    h.gmail.mockRejectedValue(new Error("Gmail API 503: Service Unavailable"))
    await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    const failed = h.ops.find((o) => o.kind === "update" && o.payload?.email_status === "failed")
    expect(String(failed?.payload?.email_error).startsWith(SEND_UNCONFIRMED_PREFIX)).toBe(true)
  })

  it("an error BEFORE the hand-off (a file cannot be read) is a plain failure: nothing went out, no warning", async () => {
    h.claims = [CLAIMED]
    h.fileBytes = null
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r).toEqual({ ok: false, error: 'Could not read the file "p.pdf" from storage.' })
    expect(h.gmail).not.toHaveBeenCalled()
    const failed = h.ops.find((o) => o.kind === "update" && o.payload?.email_status === "failed")
    expect(String(failed?.payload?.email_error)).not.toContain("Gmail did not confirm")
    expect(sendMayHaveGoneOut({ status: "completed", email_status: "failed", reviewed_at: "x", email_error: failed?.payload?.email_error as string })).toBe(false)
  })

  it("the warning survives the 500-character limit on the saved error", async () => {
    h.claims = [CLAIMED]
    h.gmail.mockRejectedValue(new Error("x".repeat(2000)))
    await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    const failed = h.ops.find((o) => o.kind === "update" && o.payload?.email_status === "failed")
    expect(String(failed?.payload?.email_error).length).toBeLessThanOrEqual(500)
    expect(String(failed?.payload?.email_error).startsWith(SEND_UNCONFIRMED_PREFIX)).toBe(true)
  })
})

describe("files go out called what is really stored (an iPhone photo is stored as a JPEG)", () => {
  it("attaches the photo as a .jpg with an image/jpeg type, never as .HEIC / image/heic", async () => {
    h.claims = [IPHONE]
    h.described = { name: "IMG_4521.jpg", contentType: "image/jpeg" }
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r.ok).toBe(true)
    const mime = decode((h.gmail.mock.calls[0][1] as { raw: string }).raw)
    expect(attachments(mime)).toEqual([{ type: "image/jpeg", name: "IMG_4521.jpg" }])
    expect(mime).not.toMatch(/image\/hei[cf]/i)
    expect(htmlOf(mime)).not.toMatch(/\.hei[cf]/i)
  })

  it("keeps the original name and type when Storage still holds the original (the conversion failed)", async () => {
    h.claims = [IPHONE]
    h.described = { name: "IMG_4521.HEIC", contentType: "image/heic" }
    await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    const mime = decode((h.gmail.mock.calls[0][1] as { raw: string }).raw)
    expect(attachments(mime)).toEqual([{ type: "image/heic", name: "IMG_4521.HEIC" }])
  })

  it("the same real name is used in the download-link version (applications over the attachment limit)", async () => {
    h.claims = [IPHONE]
    h.fileBytes = 19 * 1024 * 1024 // over the 18 MB attach limit → 7-day links instead of attachments
    h.described = { name: "IMG_4521.jpg", contentType: "image/jpeg" }
    const r = await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(r.ok).toBe(true)
    const mime = decode((h.gmail.mock.calls[0][1] as { raw: string }).raw)
    expect(attachments(mime)).toEqual([]) // nothing attached
    expect(htmlOf(mime)).toContain(">IMG_4521.jpg</a>")
    expect(htmlOf(mime)).not.toMatch(/\.hei[cf]/i)
  })

  it("an application right at the attach limit is attached, one byte over becomes links (the boundary the bug hunter found untested)", async () => {
    const LIMIT = 18 * 1024 * 1024
    h.claims = [CLAIMED]
    h.fileBytes = LIMIT
    await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(attachments(decode((h.gmail.mock.calls[0][1] as { raw: string }).raw))).toHaveLength(1)
    h.ops = []
    h.gmail.mockClear()
    h.claims = [CLAIMED]
    h.fileBytes = LIMIT + 1
    await deliverSubmission("id1", { by: "luca@x.co", confirmTo: ["sekureye22@gmail.com"] })
    expect(attachments(decode((h.gmail.mock.calls[0][1] as { raw: string }).raw))).toHaveLength(0)
  })
})
