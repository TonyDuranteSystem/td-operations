import { describe, it, expect } from "vitest"
import { resolveMessageIsHtml } from "@/lib/email-store/read"

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
