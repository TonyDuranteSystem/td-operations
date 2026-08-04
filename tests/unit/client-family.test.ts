import { describe, it, expect } from "vitest"
import { resolveClientFamily, ownerKeyFor, type ClientLink } from "@/lib/inbox/client-family"

/**
 * THE LAYER THAT DECIDES WHETHER TWO FILES BELONG TO THE SAME CLIENT.
 *
 * It had no tests at all for two rounds, and it was wrong three ways — every one
 * of them invisible, because there was no seam to test. These are written so
 * that removing the rule fails them:
 *  - a person resolves to their COMPANY (or "the company's articles + the
 *    owner's ITIN" reads as two clients, on the everyday correct email);
 *  - the answer does not depend on the order the database returns rows (the
 *    same email prepared twice must read the same, and the worker is explicitly
 *    told to re-run its search on a later turn);
 *  - the SCREEN's company wins for a client who has two of them.
 */

const ACME = "acct-acme"
const BETA = "acct-beta"
const MARIO = "contact-mario"
const GIULIA = "contact-giulia"

/** Mario owns two companies; Giulia is a second member of Acme. */
const LINKS: ClientLink[] = [
  { account_id: ACME, contact_id: MARIO },
  { account_id: BETA, contact_id: MARIO },
  { account_id: ACME, contact_id: GIULIA },
]

describe("resolveClientFamily", () => {
  it("pulls the people behind a pinned company into the family", () => {
    const f = resolveClientFamily(LINKS, { accountId: ACME })
    expect(f.ids.has(MARIO)).toBe(true)
    expect(f.ids.has(GIULIA)).toBe(true)
  })

  it("resolves a person to the company on screen, NOT to their other one", () => {
    // This is the whole point: an ITIN letter is filed against Mario. On Acme's
    // screen it must read as Acme's file, whichever link row came back first.
    const f = resolveClientFamily(LINKS, { accountId: ACME })
    expect(f.accountOfContact.get(MARIO)).toBe(ACME)
    const reversed = resolveClientFamily([...LINKS].reverse(), { accountId: ACME })
    expect(reversed.accountOfContact.get(MARIO)).toBe(ACME)
  })

  it("gives the SAME answer whatever order the rows arrive in — all six orderings", () => {
    // The database query has no ORDER BY. The previous version took whichever
    // row happened to be first, so the same email warned or did not at random,
    // and re-preparing it could flip the answer.
    const orderings: ClientLink[][] = [
      [LINKS[0], LINKS[1], LINKS[2]],
      [LINKS[0], LINKS[2], LINKS[1]],
      [LINKS[1], LINKS[0], LINKS[2]],
      [LINKS[1], LINKS[2], LINKS[0]],
      [LINKS[2], LINKS[0], LINKS[1]],
      [LINKS[2], LINKS[1], LINKS[0]],
    ]
    const answers = orderings.map((rows) => {
      const f = resolveClientFamily(rows, { accountId: ACME })
      return JSON.stringify({ ids: [...f.ids].sort(), mario: f.accountOfContact.get(MARIO) })
    })
    expect(new Set(answers).size).toBe(1)
  })

  it("reaches the other company even when the chain is ADVERSARIALLY ordered", () => {
    // NAMES CHOSEN DELIBERATELY. Rows are sorted for determinism, so with
    // friendly names one pass happens to be enough and a single-pass bug hides.
    // Here the pinned company sorts LAST ("z"), so the link that pulls the
    // second company in is seen BEFORE the person is in the family: only an
    // expansion that repeats until nothing changes reaches it.
    const pinnedLast: ClientLink[] = [
      { account_id: "acct-b-other", contact_id: "contact-a-person" },
      { account_id: "acct-z-pinned", contact_id: "contact-a-person" },
    ]
    const f = resolveClientFamily(pinnedLast, { accountId: "acct-z-pinned" })
    expect(f.ids.has("contact-a-person")).toBe(true)
    expect(f.ids.has("acct-b-other")).toBe(true)
  })

  it("the SCREEN's company wins even when another sorts ahead of it", () => {
    // Same trick in the other direction: without the pinned-account preference,
    // the alphabetically-first company would silently become the person's
    // canonical client, and a document of theirs would read as foreign.
    const f = resolveClientFamily(
      [
        { account_id: "acct-a-other", contact_id: "contact-x" },
        { account_id: "acct-z-pinned", contact_id: "contact-x" },
      ],
      { accountId: "acct-z-pinned" },
    )
    expect(f.accountOfContact.get("contact-x")).toBe("acct-z-pinned")
  })

  it("reaches a client's OTHER company through the person, whatever the row order", () => {
    // company → person → their second company. The old one-pass expansion only
    // got there if the rows happened to be ordered favourably; the direction
    // that failed was the silent one, where a legally separate company's
    // document went out with no warning at all.
    for (const rows of [LINKS, [...LINKS].reverse()]) {
      const f = resolveClientFamily(rows, { accountId: ACME })
      expect(f.ids.has(BETA)).toBe(true)
    }
  })

  it("with NO pin, still answers the same way every time", () => {
    const a = resolveClientFamily(LINKS, {})
    const b = resolveClientFamily([...LINKS].reverse(), {})
    expect(a.accountOfContact.get(MARIO)).toBe(b.accountOfContact.get(MARIO))
  })

  it("a pinned CONTACT pulls in the companies they belong to", () => {
    const f = resolveClientFamily(LINKS, { contactId: MARIO })
    expect(f.ids.has(ACME)).toBe(true)
    expect(f.ids.has(BETA)).toBe(true)
  })

  it("no links at all: the pinned ids are the whole family, and nothing throws", () => {
    const f = resolveClientFamily([], { accountId: ACME })
    expect([...f.ids]).toEqual([ACME])
    expect(f.accountOfContact.size).toBe(0)
  })

  it("does not drag in an unrelated client", () => {
    const f = resolveClientFamily(LINKS, { accountId: ACME })
    expect(f.ids.has("acct-someone-else")).toBe(false)
  })
})

describe("ownerKeyFor", () => {
  it("uses the company when the document is filed against one", () => {
    const f = resolveClientFamily(LINKS, { accountId: ACME })
    expect(ownerKeyFor({ account_id: BETA, contact_id: MARIO }, f)).toBe(BETA)
  })

  it("resolves a PERSON's document to their company — the ITIN case", () => {
    const f = resolveClientFamily(LINKS, { accountId: ACME })
    expect(ownerKeyFor({ contact_id: MARIO }, f)).toBe(ACME)
  })

  it("falls back to the person when we know of no company for them", () => {
    const f = resolveClientFamily([], { accountId: ACME })
    expect(ownerKeyFor({ contact_id: "contact-unknown" }, f)).toBe("contact-unknown")
  })

  it("returns nothing for a document with no owner at all", () => {
    const f = resolveClientFamily(LINKS, { accountId: ACME })
    expect(ownerKeyFor({}, f)).toBeUndefined()
  })

  it("TWO MEMBERS of the same company come out as ONE client", () => {
    // Mario's and Giulia's personal documents on one email is not a mix.
    const f = resolveClientFamily(LINKS, { accountId: ACME })
    expect(ownerKeyFor({ contact_id: MARIO }, f)).toBe(ownerKeyFor({ contact_id: GIULIA }, f))
  })
})
