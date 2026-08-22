import { describe, it, expect } from "vitest"
import { decidePolishLanguage } from "@/lib/portal/polish-language"

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
