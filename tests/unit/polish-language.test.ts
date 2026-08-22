import { describe, it, expect } from "vitest"
import { decidePolishLanguage, pickLastClientMessage } from "@/lib/portal/polish-language"

/**
 * AI Polish's target-language decision (dev job 9c251e65).
 *
 * Antonio, 2026-08-22: read the language the CLIENT is actually writing in this
 * conversation — never a stored field, never a "primary contact" lookup. If
 * there's nothing reliable to read (no client message yet, or too short/
 * ambiguous to tell), don't guess — ask a human which language to use.
 */

const REAL_ENGLISH = "We've uploaded your Office Lease Agreement in the portal — please sign it as soon as possible and let us know if you have any questions."
const REAL_ITALIAN = "Abbiamo caricato il tuo Contratto di Locazione dell'ufficio nel portale — ti chiediamo di firmarlo il prima possibile e siamo a disposizione per qualsiasi domanda."

describe("decidePolishLanguage", () => {
  it("matches the client's own detected language by default", () => {
    expect(decidePolishLanguage({ preserveLanguage: false, lastClientMessage: REAL_ITALIAN }))
      .toEqual({ kind: "language", language: "Italian" })
    expect(decidePolishLanguage({ preserveLanguage: false, lastClientMessage: REAL_ENGLISH }))
      .toEqual({ kind: "language", language: "English" })
  })

  it("asks when there is no client message at all (brand-new conversation)", () => {
    expect(decidePolishLanguage({ preserveLanguage: false, lastClientMessage: null }))
      .toEqual({ kind: "ask" })
    expect(decidePolishLanguage({ preserveLanguage: false, lastClientMessage: undefined }))
      .toEqual({ kind: "ask" })
  })

  it("asks when the client's last message is too short/ambiguous to tell — never guesses", () => {
    expect(decidePolishLanguage({ preserveLanguage: false, lastClientMessage: "ok" }))
      .toEqual({ kind: "ask" })
    expect(decidePolishLanguage({ preserveLanguage: false, lastClientMessage: "Ok grazie" }))
      .toEqual({ kind: "ask" })
  })

  it("preserveLanguage=true wins even with a clearly-detectable client message", () => {
    expect(decidePolishLanguage({ preserveLanguage: true, lastClientMessage: REAL_ITALIAN }))
      .toEqual({ kind: "language", language: null })
  })

  it("preserveLanguage=true wins even with nothing to read from — no need to ask", () => {
    expect(decidePolishLanguage({ preserveLanguage: true, lastClientMessage: null }))
      .toEqual({ kind: "language", language: null })
  })

  it("an explicit staff pick (the answer to 'ask') wins over everything, including a detected client language", () => {
    expect(decidePolishLanguage({
      explicitTargetLanguage: "Spanish",
      preserveLanguage: false,
      lastClientMessage: REAL_ITALIAN,
    })).toEqual({ kind: "language", language: "Spanish" })
  })

  it("an explicit staff pick resolves what would otherwise be an ask", () => {
    expect(decidePolishLanguage({
      explicitTargetLanguage: "English",
      preserveLanguage: false,
      lastClientMessage: null,
    })).toEqual({ kind: "language", language: "English" })
  })

  it("never reads a stored field — only the conversation and explicit input matter (no clientLanguage param exists)", () => {
    // Type-level guarantee as much as a runtime one: decidePolishLanguage's input
    // has no field for a stored/account-level language at all.
    const result = decidePolishLanguage({ preserveLanguage: false, lastClientMessage: REAL_ITALIAN })
    expect(result).toEqual({ kind: "language", language: "Italian" })
  })
})

/**
 * Regression test for the live-QA incident (2026-08-22): an automated
 * out-of-office auto-reply (sender_type='system') landed right after a real
 * client message and got misread as "what the client said," because the old
 * filter (`sender_type !== 'admin'`) treats any non-admin row — including
 * automated system notices — as client speech. pickLastClientMessage fixes
 * this with a positive match on 'client' only.
 */
describe("pickLastClientMessage", () => {
  it("skips a trailing automated 'system' notice and finds the real client message underneath it — the exact incident repro", () => {
    const rows = [
      { sender_type: "system", message: "We are currently closed. Our office is open Monday to Friday, 9 AM – 3 PM Eastern Time. We will get back to you on the next business day." },
      { sender_type: "client", message: REAL_ITALIAN },
      { sender_type: "admin", message: "We've issued invoice INV-002555 for $1. Please open your portal to view and pay it." },
    ]
    expect(pickLastClientMessage(rows)).toBe(REAL_ITALIAN)
  })

  it("skips a trailing admin message the same way", () => {
    const rows = [
      { sender_type: "admin", message: "Sounds good, talking to the bank now." },
      { sender_type: "client", message: REAL_ENGLISH },
    ]
    expect(pickLastClientMessage(rows)).toBe(REAL_ENGLISH)
  })

  it("returns null when there is no client row at all (only system/admin noise)", () => {
    const rows = [
      { sender_type: "system", message: "Banking application submitted: Relay. Our team will review and submit it on your behalf." },
      { sender_type: "admin", message: "On it." },
    ]
    expect(pickLastClientMessage(rows)).toBeNull()
  })

  it("returns null for an empty conversation", () => {
    expect(pickLastClientMessage([])).toBeNull()
  })

  it("picks the MOST RECENT client row when there are several (rows are newest-first)", () => {
    const rows = [
      { sender_type: "client", message: "Second message — this one is newest." },
      { sender_type: "admin", message: "Got it, one sec." },
      { sender_type: "client", message: "First message — this one is older." },
    ]
    expect(pickLastClientMessage(rows)).toBe("Second message — this one is newest.")
  })
})
