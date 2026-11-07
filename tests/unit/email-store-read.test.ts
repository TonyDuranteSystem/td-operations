import { describe, it, expect } from "vitest"
import {
  resolveMessageIsHtml,
  selectVisibleAttachments,
  type StoredAttachmentRow,
} from "@/lib/email-store/read"

describe("resolveMessageIsHtml", () => {
  it("trusts a persisted true/false flag and never re-guesses from content", () => {
    // Even though the body contains a real <div>, a persisted false must win —
    // once we have the real MIME answer we never re-derive it from content.
    expect(resolveMessageIsHtml(false, "<div>ignored</div>")).toBe(false)
    expect(resolveMessageIsHtml(true, "no tags at all")).toBe(true)
  })

  it("falls back to the structural-tag sniff only when the column is null/undefined", () => {
    expect(resolveMessageIsHtml(null, "<div>hi</div>")).toBe(true)
    expect(resolveMessageIsHtml(undefined, "plain text, no tags")).toBe(false)
  })

  it("regression: a quoted address like <a@b.com> does NOT trigger HTML (the original 2026-07-08 bug shape)", () => {
    const body = 'On Mon, Jan 5, 2026 at 10:00 AM "Name" <a@b.com> wrote:\n> hi'
    expect(resolveMessageIsHtml(null, body)).toBe(false)
  })

  it("regression: a plain-text bracketed link does NOT trigger HTML (the reported bug)", () => {
    const body = "Ciao Tony,\n\ngrazie ancora.\n\nbalmo.it <http://balmo.it/>\nFacebook <https://facebook.com/x>"
    expect(resolveMessageIsHtml(null, body)).toBe(false)
  })

  it("still detects genuine structural HTML on historical rows", () => {
    expect(resolveMessageIsHtml(null, "<div>Ciao Antonio, come stai?</div><div>ho controllato...</div>")).toBe(true)
    expect(resolveMessageIsHtml(null, "<p>hello</p>")).toBe(true)
    expect(resolveMessageIsHtml(null, "line one<br>line two")).toBe(true)
    expect(resolveMessageIsHtml(null, '<a href="https://x.com">click</a>')).toBe(true)
    expect(resolveMessageIsHtml(null, '<img src="cid:logo">')).toBe(true)
    expect(resolveMessageIsHtml(null, "<table><tr><td>x</td></tr></table>")).toBe(true)
    expect(resolveMessageIsHtml(null, "<html><body>hi</body></html>")).toBe(true)
    expect(resolveMessageIsHtml(null, "<span>hi</span>")).toBe(true)
  })

  it("detects common single-tag formatting so old rows don't regress to raw tag text", () => {
    expect(resolveMessageIsHtml(null, "<b>bold</b> text")).toBe(true)
    expect(resolveMessageIsHtml(null, "<i>italic</i>")).toBe(true)
    expect(resolveMessageIsHtml(null, "<font color=\"red\">Important</font>")).toBe(true)
    expect(resolveMessageIsHtml(null, "<strong>hi</strong>")).toBe(true)
    expect(resolveMessageIsHtml(null, "<ul><li>one</li></ul>")).toBe(true)
    expect(resolveMessageIsHtml(null, "<blockquote>quoted</blockquote>")).toBe(true)
    expect(resolveMessageIsHtml(null, "<h1>Title</h1>")).toBe(true)
    expect(resolveMessageIsHtml(null, "line<hr>line")).toBe(true)
  })

  it("does not false-positive on ordinary comparison operators or acronyms in brackets", () => {
    expect(resolveMessageIsHtml(null, "the value is < 10 > 5 for this case")).toBe(false)
    expect(resolveMessageIsHtml(null, "reference code <ABCDEF123>")).toBe(false)
  })
})

function row(over: Partial<StoredAttachmentRow>): StoredAttachmentRow {
  return {
    gmail_attachment_id: "att-1",
    filename: "file.pdf",
    mime_type: "application/pdf",
    size_bytes: 1000,
    is_inline: false,
    content_id: null,
    ...over,
  }
}

describe("selectVisibleAttachments", () => {
  it("regression (Prime Circle, 2026-11-06): a photo ATTACHED in Gmail — stored is_inline with an f_ content id the body never references — is listed", () => {
    const samia = row({
      gmail_attachment_id: "att-samia",
      filename: "WhatsApp Image 2026-11-06 at 11.51.02.jpeg",
      mime_type: "image/jpeg",
      size_bytes: 103204,
      is_inline: true,
      content_id: "f_mw4oecxn0",
    })
    expect(selectVisibleAttachments([samia], new Set())).toEqual([
      {
        filename: "WhatsApp Image 2026-11-06 at 11.51.02.jpeg",
        mimeType: "image/jpeg",
        size: 103204,
        attachmentId: "att-samia",
      },
    ])
  })

  it("hides a picture the body already displays (signature logo / pasted image) — no duplicate chip", () => {
    const logo = row({ gmail_attachment_id: "att-logo", filename: "logo.png", mime_type: "image/png", is_inline: true, content_id: "ii_abc" })
    expect(selectVisibleAttachments([logo], new Set(["att-logo"]))).toEqual([])
  })

  it("lists the unreferenced photo but still hides the referenced logo when both are on one message", () => {
    const logo = row({ gmail_attachment_id: "att-logo", filename: "logo.png", mime_type: "image/png", is_inline: true, content_id: "ii_abc" })
    const photo = row({ gmail_attachment_id: "att-photo", filename: "passport.jpg", mime_type: "image/jpeg", is_inline: true, content_id: "f_xyz" })
    const out = selectVisibleAttachments([logo, photo], new Set(["att-logo"]))
    expect(out.map((a) => a.attachmentId)).toEqual(["att-photo"])
  })

  it("keeps hiding a NAMELESS inline part — the live-Gmail path never lists those either", () => {
    const hidden = row({ gmail_attachment_id: "att-px", filename: null, mime_type: "image/gif", is_inline: true, content_id: "px1" })
    expect(selectVisibleAttachments([hidden], new Set())).toEqual([])
    expect(selectVisibleAttachments([{ ...hidden, filename: "" }], new Set())).toEqual([])
  })

  it("lists an ordinary non-inline attachment exactly as before", () => {
    expect(selectVisibleAttachments([row({ gmail_attachment_id: "att-pdf" })], new Set())).toEqual([
      { filename: "file.pdf", mimeType: "application/pdf", size: 1000, attachmentId: "att-pdf" },
    ])
  })

  it("falls back to safe defaults for a non-inline row missing name/type/size (unchanged behaviour)", () => {
    const odd = row({ gmail_attachment_id: "att-odd", filename: null, mime_type: null, size_bytes: null })
    expect(selectVisibleAttachments([odd], new Set())).toEqual([
      { filename: "attachment", mimeType: "application/octet-stream", size: 0, attachmentId: "att-odd" },
    ])
  })

  it("returns an empty list for a message with no attachments", () => {
    expect(selectVisibleAttachments([], new Set())).toEqual([])
  })
})
