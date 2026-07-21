/**
 * lib/public-forms/signing-failures.ts — client-facing messages for a failed
 * signing step on the PUBLIC signing pages.
 *
 * These exist because the signing pages wrote the PDF, inserted the contract row
 * and flipped the offer status without checking any of them: a client could sign,
 * see "Contract Signed Successfully!", pay by wire, and leave TD with no signed
 * PDF and no contract row. The content rule set by the council is the thing under
 * test here — a failed signature is a LEGAL event, so the client must be told the
 * document is NOT signed and given someone to contact.
 */

import { describe, it, expect } from "vitest"
import {
  SigningFailure,
  isClientFacingError,
  signingFailureMessage,
  signingLang,
  storageWriteFailed,
  type SigningStage,
} from "@/lib/public-forms/signing-failures"

const STAGES: SigningStage[] = ["document_upload", "record", "status"]

describe("storageWriteFailed", () => {
  it("passes a successful response", () => {
    expect(storageWriteFailed({ ok: true, status: 200 })).toBe(false)
    expect(storageWriteFailed({ status: 201 })).toBe(false)
  })

  it("fails every non-2xx, including the ones RLS produces", () => {
    expect(storageWriteFailed({ ok: false, status: 403 })).toBe(true) // RLS denial
    expect(storageWriteFailed({ ok: false, status: 401 })).toBe(true)
    expect(storageWriteFailed({ status: 500 })).toBe(true)
    expect(storageWriteFailed({ status: 400 })).toBe(true)
  })

  it("treats a missing or malformed response as a failure, never a success", () => {
    // A thrown fetch, an aborted request, or a mocked-away response must never
    // read as "the signature was saved".
    expect(storageWriteFailed(null)).toBe(true)
    expect(storageWriteFailed(undefined)).toBe(true)
    expect(storageWriteFailed({})).toBe(true)
  })

  it("prefers ok over status when both are present", () => {
    expect(storageWriteFailed({ ok: false, status: 200 })).toBe(true)
  })
})

describe("signingLang", () => {
  it("returns it only for an exact italian marker", () => {
    expect(signingLang("it")).toBe("it")
  })

  it("falls back to english for anything else", () => {
    expect(signingLang("en")).toBe("en")
    expect(signingLang(null)).toBe("en")
    expect(signingLang(undefined)).toBe("en")
    expect(signingLang("")).toBe("en")
    expect(signingLang("IT")).toBe("en")
    expect(signingLang("italian")).toBe("en")
  })
})

describe("signingFailureMessage — the content rule", () => {
  it.each(STAGES)("%s tells the client to contact support", stage => {
    expect(signingFailureMessage(stage, "en")).toContain("support@tonydurante.us")
    expect(signingFailureMessage(stage, "it")).toContain("support@tonydurante.us")
  })

  it.each(["document_upload", "record"] as SigningStage[])(
    "%s states plainly that the document is NOT signed",
    stage => {
      expect(signingFailureMessage(stage, "en")).toContain("NOT signed")
      expect(signingFailureMessage(stage, "it")).toContain("NON è firmato")
    },
  )

  it("the status stage does NOT claim the document is unsigned — the signature WAS saved", () => {
    // Getting this backwards would tell a client their signed document is
    // unsigned, which is its own harm.
    expect(signingFailureMessage("status", "en")).not.toContain("NOT signed")
    expect(signingFailureMessage("status", "en")).toContain("saved")
    expect(signingFailureMessage("status", "it")).not.toContain("NON è firmato")
    expect(signingFailureMessage("status", "it")).toContain("salvata")
  })

  it.each(STAGES)("%s warns against assuming it went through", stage => {
    expect(signingFailureMessage(stage, "en").toLowerCase()).toContain("do not assume")
    expect(signingFailureMessage(stage, "it").toLowerCase()).toContain("non dare per scontato")
  })

  it("returns a distinct message per stage, in both languages", () => {
    for (const lang of ["en", "it"] as const) {
      const msgs = STAGES.map(s => signingFailureMessage(s, lang))
      expect(new Set(msgs).size).toBe(STAGES.length)
    }
  })

  it("never returns an empty or placeholder message", () => {
    for (const lang of ["en", "it"] as const) {
      for (const stage of STAGES) {
        const m = signingFailureMessage(stage, lang)
        expect(m.length).toBeGreaterThan(40)
        expect(m).not.toContain("undefined")
        expect(m).not.toContain("[object")
      }
    }
  })

  it("leaks no internal detail — no status codes, no supabase/postgres wording", () => {
    // A raw storage or database error on a legal-signing screen reads as a
    // broken site and can leak internal shape. Detail goes to the console.
    for (const lang of ["en", "it"] as const) {
      for (const stage of STAGES) {
        const m = signingFailureMessage(stage, lang).toLowerCase()
        expect(m).not.toMatch(/supabase|postgres|rls|policy|409|403|500|null value|violates/)
      }
    }
  })

  it("english and italian differ (the italian is not an untranslated copy)", () => {
    for (const stage of STAGES) {
      expect(signingFailureMessage(stage, "it")).not.toBe(signingFailureMessage(stage, "en"))
    }
  })
})

describe("SigningFailure / isClientFacingError", () => {
  it("carries the finished copy as its message", () => {
    const e = new SigningFailure("document_upload", "it")
    expect(e.message).toBe(signingFailureMessage("document_upload", "it"))
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe("SigningFailure")
  })

  it("is recognised so a catch block renders it verbatim instead of decorating it", () => {
    // The signing page's catch does: 'Error: ' + e.message + '. Please try again.'
    // Applying that to our copy would produce a doubled "Please try again".
    expect(isClientFacingError(new SigningFailure("record", "en"))).toBe(true)
  })

  it("does NOT claim an ordinary error is client-facing", () => {
    expect(isClientFacingError(new Error("TypeError: undefined is not a function"))).toBe(false)
    expect(isClientFacingError(null)).toBe(false)
    expect(isClientFacingError(undefined)).toBe(false)
    expect(isClientFacingError("a string")).toBe(false)
    expect(isClientFacingError({ clientFacing: "yes" })).toBe(false)
    expect(isClientFacingError({})).toBe(false)
  })
})
