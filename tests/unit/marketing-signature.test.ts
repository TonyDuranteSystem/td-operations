import { describe, expect, it } from "vitest"
import { buildSignature } from "@/lib/email/signature"
import { composeMessage } from "@/lib/marketing/inbox/compose"
import { signatureFor } from "@/lib/marketing/inbox/send"
import type { InboxMailbox } from "@/lib/marketing/inbox/mailboxes"

const box = (over: Partial<InboxMailbox> = {}): InboxMailbox => ({ address: "rocco@tonydurante.us", people: [], signature_name: "", signature_title: "", signature_phone: "", ...over })

describe("the company signature with a person's own details", () => {
  it("empty fields keep the company's own name and phone; the email is the mailbox", () => {
    const s = buildSignature({ sender: "support", variant: "text", includeSignoff: false, identity: { email: "rocco@tonydurante.us" } })
    expect(s.text).toContain("Tony Durante LLC")
    expect(s.text).toContain("+1 (727) 452-1093")
    expect(s.text).toContain("rocco@tonydurante.us")
    expect(s.text).not.toContain("support@tonydurante.us")
  })
  it("name, title and phone replace the company's; the company address stays", () => {
    const s = buildSignature({ sender: "support", variant: "gala", includeSignoff: false, identity: { name: "Rocco Bianchi", title: "Sales, Tony Durante LLC", phone: "+39 333 1234567", email: "rocco@tonydurante.us" } })
    expect(s.text.split("\n")).toEqual(["Rocco Bianchi", "Sales, Tony Durante LLC", "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771", "+39 333 1234567", "rocco@tonydurante.us"])
    expect(s.html).toContain("Rocco Bianchi")
    expect(s.html).toContain('href="tel:+393331234567"')
    expect(s.html).toContain("signature-badges.png") // Full carries the company artwork
  })
  it("everything typed in the settings is escaped before it reaches the HTML", () => {
    const s = buildSignature({ sender: "support", variant: "gala", includeSignoff: false, identity: { name: '<img src=x onerror=alert(1)>', title: '"><script>x</script>', phone: "1&2", email: "a@tonydurante.us" } })
    expect(s.html).not.toContain("<img src=x")
    expect(s.html).not.toContain("<script>")
    expect(s.html).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })
  it("the portrait is never used: Antonio's own block stays Antonio's", () => {
    const s = buildSignature({ sender: "support", variant: "gala", includeSignoff: false, identity: { name: "Rocco", email: "rocco@tonydurante.us" } })
    expect(s.html).not.toContain("signature-antonio")
  })
})

describe("the signature picked next to Send", () => {
  it("a new email defaults to Full, an answer to Compact, 'none' sends nothing", () => {
    expect(signatureFor(box(), "new", undefined)?.html).toContain("signature-badges.png")
    const compact = signatureFor(box(), "reply", undefined)!
    expect(compact.html).not.toContain("signature-badges.png")
    expect(compact.html).toContain("signature-td-mark.png")
    expect(signatureFor(box(), "new", "none")).toBeNull()
  })
  it("uses the mailbox's saved name / title / phone and its own address", () => {
    const s = signatureFor(box({ signature_name: "Rocco Bianchi", signature_title: "Sales" }), "new", "text")!
    expect(s.text).toContain("Rocco Bianchi")
    expect(s.text).toContain("Sales")
    expect(s.text).toContain("rocco@tonydurante.us")
  })
  it("nonsense or the personal portrait choice from a hand-made request falls back safely", () => {
    expect(signatureFor(box(), "new", "hat")?.html).not.toContain("signature-antonio")
    expect(signatureFor(box(), "reply", "<script>")?.html).toContain("signature-td-mark.png")
  })
})

describe("a signature in a saved draft", () => {
  it("sits in a marked block, so re-opening the draft can lift it out of the editor", () => {
    const sig = signatureFor(box({ signature_name: "Rocco" }), "new", "gala")
    const c = composeMessage({ from: "rocco@tonydurante.us", to: "a@example.test", subject: "x", message: "Hi", signature: sig, draft: true })
    expect(c.ok).toBe(true)
    if (c.ok) {
      const b64 = /Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(Buffer.from(c.raw, "base64url").toString("utf8"))?.[1] ?? ""
      const html = Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf-8")
      expect(html).toContain('<div data-td-signature="1">')
      expect(html).toContain("Rocco")
    }
  })
})
