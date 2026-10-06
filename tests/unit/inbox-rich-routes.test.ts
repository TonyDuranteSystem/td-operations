/**
 * Formatted replies through the REAL routes (dev job bbc70ff8, step 2): /api/inbox/reply and /api/inbox/draft.
 * Gmail is mocked at its edge; everything between the request and the raw email — body resolution, the
 * sanitizer, the guards, the MIME builder — is the real code, and the email is decoded and inspected.
 *
 * What these protect:
 *  - a plain reply is EXACTLY what it was (escaped text -> <br />, no formatting wrapper)
 *  - a formatted reply carries the sanitized HTML and a text/plain built FROM it; the client's own `message` is ignored
 *  - hostile HTML never reaches the email; an empty/script-only body is refused and nothing is sent
 *  - the [blank] guard looks at what will actually be sent (a placeholder split across tags is still caught)
 *  - Save draft carries the formatting instead of flattening it
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const st = vi.hoisted(() => ({
  posts: [] as Array<{ path: string; body: Record<string, unknown> }>,
}))

vi.mock("@/lib/auth/require-staff-route", () => ({ requireStaffRoute: async () => null }))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }) }))
vi.mock("@/lib/auth", () => ({ isStaffUser: () => true, isAdmin: () => true }))
vi.mock("@/lib/messaging/send-dispatcher", () => ({ dispatchWhatsAppMessage: vi.fn() }))
vi.mock("@/lib/messaging/attachment-staging", () => ({ resolveWhatsAppAttachmentUrl: vi.fn() }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/gmail", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>
  return {
    ...actual,
    extractBody: () => "Thanks, Tony!\nOkay, no problem.",
    gmailPost: async (path: string, body: Record<string, unknown>) => {
      st.posts.push({ path, body })
      return { id: "gmail-id-1" }
    },
  }
})
vi.mock("@/lib/inbox/reply-target", () => {
  class ReplyTargetError extends Error {
    status = 400
  }
  return {
    ReplyTargetError,
    buildThreadQuotes: async () => [],
    resolveReplyTarget: async () => ({
      message: { id: "m1", payload: {} },
      replyToAddresses: ["michael@fresh-ops.com"],
      quotedFrom: "Michael Darby <michael@fresh-ops.com>",
      subject: "Introduction and Private Office Enquiry",
      messageIdHeader: "<abc123@mail.example>",
      references: "",
      date: "Mon, 5 Oct 2026 13:02:12 +0000",
      cc: [],
    }),
  }
})

import { POST as replyPOST } from "@/app/api/inbox/reply/route"
import { POST as draftPOST } from "@/app/api/inbox/draft/route"

function decodeEmail(raw64url: string) {
  const raw = Buffer.from(raw64url, "base64url").toString("utf-8")
  const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] ?? ""
  const parts = raw.split(`--${boundary}`)
  const grab = (type: string) => {
    const part = parts.find((p) => p.includes(`Content-Type: ${type}`))
    if (!part) return ""
    const body = part.split(/\r?\n\r?\n/).slice(1).join("\n\n").replace(/\s+/g, "")
    return Buffer.from(body, "base64").toString("utf-8")
  }
  return { raw, text: grab("text/plain"), html: grab("text/html") }
}

const base = { conversationId: "gmail:thread-1", channel: "gmail", mailbox: "support", signature_variant: "none" }
const reply = async (body: Record<string, unknown>) => {
  const res = await replyPOST({ json: async () => ({ ...base, ...body }) } as never)
  return { status: res.status, body: await res.json() }
}
const draft = async (body: Record<string, unknown>) => {
  const res = await draftPOST({ json: async () => ({ conversationId: base.conversationId, mailbox: "support", signature_variant: "none", ...body }) } as never)
  return { status: res.status, body: await res.json() }
}
const sentEmail = () => decodeEmail(st.posts.find((p) => p.path === "/messages/send")!.body.raw as string)
const draftedEmail = () => decodeEmail(((st.posts.find((p) => p.path === "/drafts")!.body.message) as { raw: string }).raw)

beforeEach(() => {
  st.posts.length = 0
})

describe("POST /api/inbox/reply — the plain path is unchanged", () => {
  it("escapes the text and turns newlines into <br /> exactly as before; no formatted wrapper", async () => {
    const r = await reply({ message: "Hi Michael,\n\nTax & <fees> are fine.\nBest,\nTony" })
    expect(r.status).toBe(200)
    const e = sentEmail()
    expect(e.html).toContain("Hi Michael,<br /><br />Tax &amp; &lt;fees&gt; are fine.<br />Best,<br />Tony")
    expect(e.html).not.toMatch(/<p style|<ul|<strong/)
    expect(e.text.startsWith("Hi Michael,\n\nTax & <fees> are fine.\nBest,\nTony")).toBe(true)
  })

  it("html that is only plain paragraphs (default style) takes this same path — nothing is 'formatted'", async () => {
    const r = await reply({ messageHtml: "<p>Hi Michael,</p><p></p><p>Thanks.</p>" })
    expect(r.status).toBe(200)
    const e = sentEmail()
    expect(e.html).toContain("Hi Michael,<br /><br />Thanks.")
    expect(e.html).not.toMatch(/<p style/)
  })
})

describe("POST /api/inbox/reply — a formatted reply", () => {
  const html =
    '<p>Hi Michael,</p><p><strong>Next steps:</strong></p><ul><li><p>sign the amendment</p></li><li><p>send it back</p></li></ul>' +
    '<p>Please <a href="https://example.com/sign">click here</a> today.</p>'

  it("sends the sanitized HTML with the chosen style, and a text/plain built FROM it", async () => {
    const r = await reply({ messageHtml: html, style: { font: "Georgia", size: "large", line: "airy", para: "wide" } })
    expect(r.status).toBe(200)
    const e = sentEmail()
    expect(e.html).toContain("font-family:Georgia,serif;font-size:18px;line-height:1.8")
    expect(e.html).toContain("<strong>Next steps:</strong>")
    expect(e.html).toContain('<ul style="margin:0 0 18px 0;padding-left:24px">')
    expect(e.html).toContain('<a href="https://example.com/sign" target="_blank" rel="noopener noreferrer">click here</a>')
    expect(e.text).toContain("Hi Michael,\nNext steps:\n• sign the amendment\n• send it back\nPlease click here (https://example.com/sign) today.")
  })

  it("IGNORES the client's own `message` for a formatted send (the two halves can never disagree)", async () => {
    await reply({ message: "SOMETHING ELSE ENTIRELY", messageHtml: html, style: { line: "tight" } })
    const e = sentEmail()
    expect(e.text).not.toContain("SOMETHING ELSE")
    expect(e.html).not.toContain("SOMETHING ELSE")
  })

  it("keeps the signature and the quoted history outside the formatted wrapper", async () => {
    await reply({ messageHtml: html, style: { font: "Courier New" }, quoteMode: "message" })
    const e = sentEmail()
    expect(e.html).toContain("font-family:'Courier New',Courier,monospace")
    expect(e.html).toContain("gmail_quote")
    expect(e.text).toContain("> Thanks, Tony!")
  })

  it("renders a centred paragraph with ONE style attribute", async () => {
    await reply({ messageHtml: '<p style="text-align: center">Centred</p>', style: {} })
    const e = sentEmail()
    expect(e.html).toContain('<p style="text-align:center;margin:0 0 10px 0;line-height:1.5">Centred</p>')
  })
})

describe("POST /api/inbox/reply — hostile or empty formatted bodies", () => {
  it("never lets scripts, handlers, bad links or smuggled styles reach the email", async () => {
    const r = await reply({
      messageHtml:
        '<p onclick="steal()">Hello<script>steal()</script></p><p><a href="javascript:steal()">bad</a> ' +
        '<a href="https://td-operations.vercel.app/x">internal</a> <img src=x onerror="steal()"></p>' +
        '<p style="position:fixed;background:url(x)"><span style="color:red">r</span></p>',
      style: { font: "Verdana" },
    })
    expect(r.status).toBe(200)
    const e = sentEmail()
    for (const bad of ["script", "steal", "onclick", "onerror", "javascript:", "td-operations", "position:fixed", "background", "color:red", "<img"]) {
      expect(e.html.toLowerCase()).not.toContain(bad)
    }
    expect(e.text).toContain("Hello")
    expect(e.text).toContain("bad")
    expect(e.text).toContain("internal")
    expect(e.text).not.toContain("td-operations")
  })

  it("refuses an empty result and sends NOTHING (script only / empty paragraphs / empty list item / invisible text)", async () => {
    for (const html of ["<script>x</script>", "<p></p><p></p>", "<ul><li><p></p></li></ul>", "<p>​</p>"]) {
      const r = await reply({ message: "I am a visible message", messageHtml: html })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe("The message is empty.")
    }
    expect(st.posts).toHaveLength(0)
  })

  it("refuses an oversize formatted body", async () => {
    const r = await reply({ messageHtml: "<p>" + "a".repeat(100_001) + "</p>" })
    expect(r.status).toBe(400)
    expect(st.posts).toHaveLength(0)
  })

  it("refuses a messageHtml that is not a string", async () => {
    expect((await reply({ messageHtml: { a: 1 } })).status).toBe(400)
    expect(st.posts).toHaveLength(0)
  })
})

describe("POST /api/inbox/reply — the [blank] guard sees what will be sent", () => {
  it("catches a placeholder split across formatting tags, with the text derived from the sanitized html", async () => {
    const r = await reply({ messageHtml: "<p>The fee is [pri<strong>c</strong>e] per month.</p>" })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe("unresolved_placeholders")
    expect(r.body.placeholders).toEqual(["[price]"])
    expect(st.posts).toHaveLength(0)
  })
  it("lets it through only with the explicit confirmation", async () => {
    const r = await reply({ messageHtml: "<p>The fee is [price].</p><p><strong>bold</strong></p>", allowPlaceholders: true })
    expect(r.status).toBe(200)
  })
  it("a placeholder only the client's own `message` mentions is NOT what is sent, so it does not block", async () => {
    const r = await reply({ message: "[price]", messageHtml: "<p>All good.</p><ul><li>one</li></ul>" })
    expect(r.status).toBe(200)
  })
})

describe("POST /api/inbox/draft — a formatted draft stays formatted", () => {
  it("saves the sanitized HTML with the chosen style and the derived plain half (it used to flatten to plain text)", async () => {
    const r = await draft({
      messageHtml: "<p>Hi,</p><ol><li><p>one</p></li><li><p>two</p></li></ol><p><u>Thanks</u></p>",
      style: { font: "Tahoma", size: "small", para: "close" },
    })
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    const e = draftedEmail()
    expect(e.html).toContain("font-family:Tahoma,Geneva,sans-serif;font-size:12px")
    expect(e.html).toContain("<ol ")
    expect(e.html).toContain("<u>Thanks</u>")
    expect(e.text).toContain("Hi,\n1. one\n2. two\nThanks")
  })
  it("a plain draft is unchanged", async () => {
    const r = await draft({ message: "Draft line 1\nline 2" })
    expect(r.status).toBe(200)
    const e = draftedEmail()
    expect(e.html).toContain("Draft line 1<br />line 2")
  })
  it("refuses a script-only draft and saves nothing", async () => {
    const r = await draft({ message: "x", messageHtml: "<script>x</script>" })
    expect(r.status).toBe(400)
    // The sanitizer's own reason reaches the user (R099) — not the generic missing-fields error.
    expect(r.body.error).toBe("The message is empty.")
    expect(st.posts).toHaveLength(0)
  })
  it("refuses a non-string or oversize messageHtml with the sanitizer's reason", async () => {
    const bad = await draft({ message: "x", messageHtml: { a: 1 } })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("The formatted message is not valid.")
    const big = await draft({ message: "x", messageHtml: "<p>" + "a".repeat(100_001) + "</p>" })
    expect(big.status).toBe(400)
    expect(String(big.body.error)).toContain("too long")
    expect(st.posts).toHaveLength(0)
  })
  it("sanitizes a hostile draft exactly like a send", async () => {
    await draft({ messageHtml: '<p onclick="x">hi<script>x</script></p><a href="javascript:x">l</a>' })
    const e = draftedEmail()
    expect(e.html.toLowerCase()).not.toMatch(/script|onclick|javascript/)
  })
})
