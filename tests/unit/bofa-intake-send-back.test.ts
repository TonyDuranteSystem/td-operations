import { describe, it, expect } from "vitest"
import { RETURN_NOTE_MAX, buildSendBackEmail, cleanReturnNote } from "@/lib/bofa-intake/send-back"

describe("cleanReturnNote", () => {
  it("requires a message the client will see", () => {
    for (const bad of ["", "   ", null, undefined, 5]) expect(cleanReturnNote(bad).ok).toBe(false)
  })
  it("trims and keeps line breaks", () => {
    expect(cleanReturnNote("  fix the passport\r\nplease  ")).toEqual({ ok: true, note: "fix the passport\nplease" })
  })
  it("refuses an essay, with the length in words", () => {
    const r = cleanReturnNote("x".repeat(RETURN_NOTE_MAX + 1))
    expect(r.ok).toBe(false)
    expect("error" in r && r.error).toContain(String(RETURN_NOTE_MAX))
  })
})

describe("buildSendBackEmail", () => {
  const mail = buildSendBackEmail({ name: "Jordan Smith", note: "Line <b>one</b>\nLine two & more", url: "https://app.example/bank-application/tok_123" })

  it("addresses the client by first name, in English, with a plain subject", () => {
    expect(mail.subject).toBe("Please update your bank account application")
    expect(mail.html).toContain("Hello Jordan,")
  })
  it("escapes everything staff typed", () => {
    expect(mail.html).toContain("Line &lt;b&gt;one&lt;/b&gt;")
    expect(mail.html).toContain("Line two &amp; more")
    expect(mail.html).not.toContain("<b>one</b>")
  })
  it("carries the new link and says the form starts blank", () => {
    expect(mail.html).toContain('href="https://app.example/bank-application/tok_123"')
    expect(mail.html).toContain("does not show your earlier answers")
  })
  it("still reads well with no name on file", () => {
    expect(buildSendBackEmail({ name: null, note: "n", url: "https://u" }).html).toContain("Hello,")
  })
})
