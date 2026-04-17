/**
 * P3.4 #5 — lib/operations/email.ts unit tests
 *
 * Covers: sanitizeToAscii, renderEmailTemplate placeholder substitution,
 * sendEmail duplicate detection, successful send path, tracking behavior,
 * lead auto-flip on tag=offer, Drive attachment merging, reply threading.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}))

// ─── Mock state ────────────────────────────────────────

let duplicateRow: { id: string; created_at: string; gmail_message_id: string } | null = null
let templateRow: {
  template_name: string
  subject_template: string
  body_template: string
  language: string | null
  active: boolean
} | null = null

const trackingInserts: Array<Record<string, unknown>> = []
const leadUpdates: Array<{ id: string; payload: Record<string, unknown> }> = []

// ─── Mocks ─────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "email_tracking") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          gte: vi.fn().mockReturnThis(),
          limit: vi.fn(() => Promise.resolve({
            data: duplicateRow ? [duplicateRow] : [],
            error: null,
          })),
          insert: vi.fn((payload: Record<string, unknown>) => {
            trackingInserts.push(payload)
            return Promise.resolve({ data: null, error: null })
          }),
        }
      }
      if (table === "email_templates") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(() => Promise.resolve({ data: templateRow, error: null })),
        }
      }
      if (table === "leads") {
        let filterId: string | null = null
        let pendingUpdate: Record<string, unknown> | null = null
        const chain = {
          update: vi.fn((payload: Record<string, unknown>) => {
            pendingUpdate = payload
            return chain
          }),
          eq: vi.fn((_col: string, value: string) => {
            filterId = value
            if (pendingUpdate) {
              leadUpdates.push({ id: value, payload: pendingUpdate })
              pendingUpdate = null
            }
            return Promise.resolve({ data: null, error: null })
          }),
        }
        void filterId
        return chain
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
        insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
        update: vi.fn().mockReturnThis(),
      }
    },
  },
}))

const gmailPostCalls: Array<{ endpoint: string; body: Record<string, unknown>; asUser?: string }> = []

vi.mock("@/lib/gmail", () => ({
  gmailPost: vi.fn(async (endpoint: string, body: Record<string, unknown>, asUser?: string) => {
    gmailPostCalls.push({ endpoint, body, asUser })
    return { id: "msg_test_123", threadId: "thr_test_456", labelIds: ["SENT"] }
  }),
  gmailGet: vi.fn(async () => ({
    threadId: "thr_original",
    payload: {
      headers: [
        { name: "Message-ID", value: "<original@example.com>" },
        { name: "References", value: "<prev@example.com>" },
      ],
    },
  })),
  getHeader: (headers: Array<{ name: string; value: string }>, name: string) =>
    headers.find((h) => h.name === name)?.value,
}))

const actionLogCalls: Array<Record<string, unknown>> = []
vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn((params: Record<string, unknown>) => {
    actionLogCalls.push(params)
  }),
}))

vi.mock("@/lib/config", () => ({
  APP_BASE_URL: "https://app.tonydurante.us",
}))

const driveDownloadCalls: string[] = []
vi.mock("@/lib/google-drive", () => ({
  downloadFileBinary: vi.fn(async (fileId: string) => {
    driveDownloadCalls.push(fileId)
    return {
      buffer: Buffer.from(`contents-of-${fileId}`),
      mimeType: "application/pdf",
      fileName: `file-${fileId}.pdf`,
    }
  }),
}))

// ─── Reset between tests ───────────────────────────────

beforeEach(() => {
  duplicateRow = null
  templateRow = null
  trackingInserts.length = 0
  leadUpdates.length = 0
  gmailPostCalls.length = 0
  actionLogCalls.length = 0
  driveDownloadCalls.length = 0
})

// ─── Tests ─────────────────────────────────────────────

describe("sanitizeToAscii", () => {
  it("replaces common Unicode with ASCII", async () => {
    const { sanitizeToAscii } = await import("@/lib/operations/email")
    expect(sanitizeToAscii("it\u2019s \u201Chello\u201D \u2014 done"))
      .toBe("it's \"hello\" -- done")
    expect(sanitizeToAscii("\u2022 item \u2026 end \u2192"))
      .toBe("* item ... end ->")
  })

  it("is a no-op on plain ASCII", async () => {
    const { sanitizeToAscii } = await import("@/lib/operations/email")
    expect(sanitizeToAscii("plain ascii text -- yes")).toBe("plain ascii text -- yes")
  })
})

describe("renderEmailTemplate", () => {
  it("substitutes {{var}} placeholders in subject and body", async () => {
    templateRow = {
      template_name: "welcome",
      subject_template: "Hello {{first_name}}",
      body_template: "<p>Welcome {{first_name}} to {{company}}</p>",
      language: "en",
      active: true,
    }
    const { renderEmailTemplate } = await import("@/lib/operations/email")
    const rendered = await renderEmailTemplate("tpl-uuid", {
      first_name: "Antonio",
      company: "TD",
    })
    expect(rendered?.subject).toBe("Hello Antonio")
    expect(rendered?.body_html).toBe("<p>Welcome Antonio to TD</p>")
    expect(rendered?.language).toBe("en")
  })

  it("leaves missing placeholders intact", async () => {
    templateRow = {
      template_name: "t",
      subject_template: "Hello {{first_name}}",
      body_template: "Dear {{missing}}",
      language: null,
      active: true,
    }
    const { renderEmailTemplate } = await import("@/lib/operations/email")
    const rendered = await renderEmailTemplate("tpl", { first_name: "X" })
    expect(rendered?.subject).toBe("Hello X")
    expect(rendered?.body_html).toBe("Dear {{missing}}")
  })

  it("returns null for inactive templates", async () => {
    templateRow = {
      template_name: "t",
      subject_template: "s",
      body_template: "b",
      language: "en",
      active: false,
    }
    const { renderEmailTemplate } = await import("@/lib/operations/email")
    const rendered = await renderEmailTemplate("tpl")
    expect(rendered).toBeNull()
  })

  it("returns null when template not found", async () => {
    templateRow = null
    const { renderEmailTemplate } = await import("@/lib/operations/email")
    const rendered = await renderEmailTemplate("missing-uuid")
    expect(rendered).toBeNull()
  })
})

describe("sendEmail — duplicate detection", () => {
  it("blocks a send when a recent email with same recipient+subject exists", async () => {
    duplicateRow = {
      id: "prior-row-1",
      created_at: "2026-04-17T10:00:00Z",
      gmail_message_id: "msg_prior_999",
    }
    const { sendEmail } = await import("@/lib/operations/email")
    const result = await sendEmail({
      to: "client@example.com",
      subject: "Invoice INV-001",
      body_html: "<p>Please pay</p>",
    })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("duplicate_blocked")
    expect(result.duplicate?.gmail_message_id).toBe("msg_prior_999")
    expect(gmailPostCalls.length).toBe(0)
  })

  it("skips duplicate check when reply_to_message_id is set", async () => {
    duplicateRow = {
      id: "prior",
      created_at: "2026-04-17T10:00:00Z",
      gmail_message_id: "msg_prior",
    }
    const { sendEmail } = await import("@/lib/operations/email")
    const result = await sendEmail({
      to: "client@example.com",
      subject: "Re: Invoice",
      body_html: "<p>Reply</p>",
      reply_to_message_id: "msg_original",
    })
    expect(result.outcome).toBe("sent")
    expect(gmailPostCalls.length).toBe(1)
  })

  it("skips duplicate check when skip_duplicate_check=true", async () => {
    duplicateRow = {
      id: "prior",
      created_at: "2026-04-17T10:00:00Z",
      gmail_message_id: "msg_prior",
    }
    const { sendEmail } = await import("@/lib/operations/email")
    const result = await sendEmail({
      to: "client@example.com",
      subject: "Invoice INV-001",
      body_html: "<p>Body</p>",
      skip_duplicate_check: true,
    })
    expect(result.outcome).toBe("sent")
  })
})

describe("sendEmail — successful send", () => {
  it("sends with tracking pixel + email_tracking insert + action_log", async () => {
    const { sendEmail } = await import("@/lib/operations/email")
    const result = await sendEmail({
      to: "client@example.com",
      subject: "Welcome",
      body_html: "<html><body><p>Hi</p></body></html>",
      account_id: "acct-1",
      contact_id: "ctc-1",
      tag: "onboarding",
    })

    expect(result.success).toBe(true)
    expect(result.outcome).toBe("sent")
    expect(result.gmail_message_id).toBe("msg_test_123")
    expect(result.gmail_thread_id).toBe("thr_test_456")
    expect(result.tracking_id).toMatch(/^et_\d+_/)

    expect(trackingInserts.length).toBe(1)
    expect(trackingInserts[0].account_id).toBe("acct-1")
    expect(trackingInserts[0].contact_id).toBe("ctc-1")
    expect(trackingInserts[0].subject).toBe("Welcome")

    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].action_type).toBe("send")
    expect(actionLogCalls[0].account_id).toBe("acct-1")

    // Decode the base64-encoded HTML body part to verify the pixel is injected
    const rawB64 = (gmailPostCalls[0].body as { raw: string }).raw
    const mime = Buffer.from(rawB64, "base64url").toString("utf-8")
    const htmlPart = mime.split("Content-Type: text/html")[1]
    const htmlBase64 = htmlPart.match(/\r\n\r\n([A-Za-z0-9+/=]+)/)?.[1] || ""
    const decoded = Buffer.from(htmlBase64, "base64").toString("utf-8")
    expect(decoded).toContain("/api/track/open/et_")
  })

  it("skips tracking row when track_opens=false", async () => {
    const { sendEmail } = await import("@/lib/operations/email")
    const result = await sendEmail({
      to: "client@example.com",
      subject: "No tracking",
      body_html: "<p>Hi</p>",
      track_opens: false,
    })
    expect(result.success).toBe(true)
    expect(result.tracking_id).toBeNull()
    expect(trackingInserts.length).toBe(0)
  })

  it("sanitizes Unicode in subject and body before send", async () => {
    const { sendEmail } = await import("@/lib/operations/email")
    await sendEmail({
      to: "client@example.com",
      subject: "it\u2019s \u201Chello\u201D",
      body_html: "<p>Curly \u2018quote\u2019 and \u2022 bullet</p>",
    })
    const rawB64 = (gmailPostCalls[0].body as { raw: string }).raw
    const mime = Buffer.from(rawB64, "base64url").toString("utf-8")
    // Subject is base64-encoded in header when it has non-ASCII — after
    // sanitization, the encoded subject should be plain ASCII instead.
    expect(mime).toContain("Subject: it's \"hello\"")
    // Body parts are base64 — decode to check
    const bodyMatches = mime.match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=]+)/g)
    const decoded = (bodyMatches || [])
      .map((m) => m.split("\r\n\r\n")[1])
      .map((b64) => Buffer.from(b64, "base64").toString("utf-8"))
      .join("\n---\n")
    expect(decoded).toContain("'quote'")
    expect(decoded).toContain("* bullet")
  })
})

describe("sendEmail — lead auto-update on offer tag", () => {
  it("flips lead status to Offer Sent when tag='offer' and lead_id set", async () => {
    const { sendEmail } = await import("@/lib/operations/email")
    const result = await sendEmail({
      to: "lead@example.com",
      subject: "Your offer",
      body_html: "<p>Offer</p>",
      lead_id: "lead-42",
      tag: "offer",
    })
    expect(result.lead_auto_updated).toBe(true)
    expect(leadUpdates.length).toBe(1)
    expect(leadUpdates[0].id).toBe("lead-42")
    expect(leadUpdates[0].payload.status).toBe("Offer Sent")
    expect(leadUpdates[0].payload.offer_status).toBe("Sent")
  })

  it("does not update lead when tag !== 'offer'", async () => {
    const { sendEmail } = await import("@/lib/operations/email")
    await sendEmail({
      to: "lead@example.com",
      subject: "Update",
      body_html: "<p>Status</p>",
      lead_id: "lead-42",
      tag: "update",
    })
    expect(leadUpdates.length).toBe(0)
  })
})

describe("sendEmail — Drive attachments", () => {
  it("downloads Drive files and attaches them to the MIME body", async () => {
    const { sendEmail } = await import("@/lib/operations/email")
    const result = await sendEmail({
      to: "client@example.com",
      subject: "With files",
      body_html: "<p>See attached</p>",
      drive_file_ids: ["drv_aaa", "drv_bbb"],
    })
    expect(driveDownloadCalls).toEqual(["drv_aaa", "drv_bbb"])
    expect(result.has_attachments).toBe(true)
    expect(result.attachment_count).toBe(2)
    expect(result.attachment_filenames).toEqual(["file-drv_aaa.pdf", "file-drv_bbb.pdf"])

    const rawB64 = (gmailPostCalls[0].body as { raw: string }).raw
    const mime = Buffer.from(rawB64, "base64url").toString("utf-8")
    expect(mime).toContain("multipart/mixed")
    expect(mime).toContain('filename="file-drv_aaa.pdf"')
    expect(mime).toContain('filename="file-drv_bbb.pdf"')
  })
})

describe("sendEmail — reply threading", () => {
  it("adds In-Reply-To and References headers when reply_to_message_id is set", async () => {
    const { sendEmail } = await import("@/lib/operations/email")
    await sendEmail({
      to: "client@example.com",
      subject: "Re: Thread",
      body_html: "<p>Reply</p>",
      reply_to_message_id: "msg_original",
    })
    const rawB64 = (gmailPostCalls[0].body as { raw: string }).raw
    const mime = Buffer.from(rawB64, "base64url").toString("utf-8")
    expect(mime).toContain("In-Reply-To: <original@example.com>")
    expect(mime).toContain("References: <prev@example.com> <original@example.com>")
    expect((gmailPostCalls[0].body as { threadId?: string }).threadId).toBe("thr_original")
  })
})

describe("plainTextToParagraphs", () => {
  it("splits on blank lines into paragraphs and converts single newlines to <br />", async () => {
    const { plainTextToParagraphs } = await import("@/lib/operations/email")
    const out = plainTextToParagraphs("Hello Antonio,\n\nFirst paragraph.\nSecond line.\n\nLast paragraph.")
    expect(out).toBe("<p>Hello Antonio,</p>\n<p>First paragraph.<br />Second line.</p>\n<p>Last paragraph.</p>")
  })

  it("escapes HTML entities in plain text", async () => {
    const { plainTextToParagraphs } = await import("@/lib/operations/email")
    const out = plainTextToParagraphs("Tags like <b>bold</b> & 'quotes' should be escaped")
    expect(out).toBe('<p>Tags like &lt;b&gt;bold&lt;/b&gt; &amp; &#39;quotes&#39; should be escaped</p>')
  })

  it("escapes all HTML input (plain-text function, callers branch on looksLikeHtml first)", async () => {
    const { plainTextToParagraphs } = await import("@/lib/operations/email")
    const input = "<p>Already formatted</p>"
    expect(plainTextToParagraphs(input)).toBe("<p>&lt;p&gt;Already formatted&lt;/p&gt;</p>")
  })

  it("collapses empty paragraphs", async () => {
    const { plainTextToParagraphs } = await import("@/lib/operations/email")
    const out = plainTextToParagraphs("\n\n\n\none\n\n\n\ntwo\n\n\n")
    expect(out).toBe("<p>one</p>\n<p>two</p>")
  })
})

describe("wrapEmailWithBrandShell", () => {
  it("wraps body with logo + footer + Arial font stack", async () => {
    const { wrapEmailWithBrandShell } = await import("@/lib/operations/email")
    const out = wrapEmailWithBrandShell("<p>Hi</p>")
    expect(out).toContain("https://app.tonydurante.us/images/logo.jpg")
    expect(out).toContain("Tony Durante LLC")
    expect(out).toContain("support@tonydurante.us")
    expect(out).toContain("font-family:Arial,Helvetica,sans-serif")
    expect(out).toContain("<p>Hi</p>")
  })
})

describe("sendEmail — wrap_with_brand", () => {
  it("converts plain text to paragraphs and wraps with brand shell", async () => {
    const { sendEmail } = await import("@/lib/operations/email")
    await sendEmail({
      to: "client@example.com",
      subject: "Brand test",
      body_html: "Hello Antonio,\n\nFirst paragraph.\n\nSecond paragraph.",
      wrap_with_brand: true,
    })
    const rawB64 = (gmailPostCalls[0].body as { raw: string }).raw
    const mime = Buffer.from(rawB64, "base64url").toString("utf-8")
    // HTML body part is base64 — decode and check
    const htmlPart = mime.split("Content-Type: text/html")[1]
    const htmlBase64 = htmlPart.match(/\r\n\r\n([A-Za-z0-9+/=]+)/)?.[1] || ""
    const decoded = Buffer.from(htmlBase64, "base64").toString("utf-8")
    expect(decoded).toContain("logo.jpg")
    expect(decoded).toContain("<p>Hello Antonio,</p>")
    expect(decoded).toContain("<p>First paragraph.</p>")
    expect(decoded).toContain("<p>Second paragraph.</p>")
    expect(decoded).toContain("support@tonydurante.us")
  })

  it("leaves body untouched when wrap_with_brand is not set", async () => {
    const { sendEmail } = await import("@/lib/operations/email")
    await sendEmail({
      to: "client@example.com",
      subject: "No wrap",
      body_html: "<p>Raw HTML body</p>",
    })
    const rawB64 = (gmailPostCalls[0].body as { raw: string }).raw
    const mime = Buffer.from(rawB64, "base64url").toString("utf-8")
    const htmlPart = mime.split("Content-Type: text/html")[1]
    const htmlBase64 = htmlPart.match(/\r\n\r\n([A-Za-z0-9+/=]+)/)?.[1] || ""
    const decoded = Buffer.from(htmlBase64, "base64").toString("utf-8")
    expect(decoded).not.toContain("logo.jpg")
    expect(decoded).toContain("<p>Raw HTML body</p>")
  })
})
