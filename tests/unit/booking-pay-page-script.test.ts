/**
 * Paid booking links (dev job 20af2e28): the inline script of the public BOOK view. A single wrong escape in the template would leave the person with a dead page, and the route tests
 * only look at the markup, so this test COMPILES the script (it is not run: it needs a browser) and checks the pieces that must survive: the email check, the messages that stay on
 * screen, and that nothing from the database can close the script tag.
 */
import { describe, it, expect } from "vitest"
import { bookViewHtml } from "@/lib/booking/pay-page-html"

const CODE = "2hhvDHUcAPqPBTXdD8HMqw"
const html = (over: Partial<Parameters<typeof bookViewHtml>[0]> = {}) => bookViewHtml({ code: CODE, money: "$1.00", label: "call", minutes: 30, name: "Maria", email: "maria@example.com", ...over })
const scriptOf = (h: string): string => {
  const m = /<script>([\s\S]*)<\/script>/.exec(h)
  if (!m) throw new Error("no script")
  return m[1]
}

describe("the BOOK view script", () => {
  it("is valid JavaScript (compiled, not run)", () => {
    expect(() => new Function(scriptOf(html()))).not.toThrow()
  })
  it("its email check is the same set of characters the server refuses (no spaces, < > ( ) \" , ; : or backslash) and lets an apostrophe through", () => {
    const src = scriptOf(html())
    const m = /\/(\^\[[^\n]*?\$)\/\.test\(e\)/.exec(src)
    expect(m, "email regex found in the script").not.toBeNull()
    const re = new RegExp(m![1])
    for (const ok of ["maria@example.com", "d'amico@example.it", "r&d@example.com", "a=b@example.com"]) expect(re.test(ok), ok).toBe(true)
    for (const bad of ["a<b@example.com", "a,b@example.com", "a b@example.com", 'a"b@example.com', "a;b@example.com", "a(b)@example.com", "ab@example", "a\\b@example.com"]) expect(re.test(bad), bad).toBe(false)
  })
  it("keeps the failure message on screen and writes out the chosen time", () => {
    const src = scriptOf(html())
    expect(src).toContain("function load(keep){if(!keep)say('')")
    expect(src).toContain("load(true)")
    expect(src).toContain("Your time: ")
    for (const reason of ["unsure", "taken", "error", "booked", "paid"]) expect(src.includes(`'${reason}'`) || reason === "unsure", reason).toBe(true)
  })
  it("a name, email, label or amount with markup in it can never close the script or break an attribute", () => {
    const h = html({ name: `"></script><script>alert(1)</script>`, email: `x"onfocus="alert(1)@a.com`, label: `</script><img src=x onerror=alert(1)>`, money: `$1</script>` })
    expect((h.match(/<script>/g) ?? []).length).toBe(1)
    expect((h.match(/<\/script>/g) ?? []).length).toBe(1)
    expect(h).not.toContain("<script>alert(1)")
    expect(h).not.toContain('value="x"onfocus')
    expect(() => new Function(scriptOf(h))).not.toThrow()
  })
})
