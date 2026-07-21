/**
 * lib/public-forms/upload-failures.ts — blocks a public form submission when a
 * file the client ATTACHED failed to upload.
 *
 * The bug being fixed: every data-collection form did `if (!upErr)
 * uploadPaths.push(path)`, then wrote `status:'completed'` and showed the green
 * success screen. A client's passport failed to upload and they were told the
 * submission was received.
 *
 * The regression these tests exist to prevent is the formation form's original
 * guard — `uploadErrors.length > 0 && uploadPaths.length === 0` — which let a
 * partial batch through as completed. That is the `blocks on a PARTIAL failure`
 * case below; it must never go green again.
 */

import { describe, it, expect } from "vitest"
import {
  shouldBlockSubmission,
  uploadFailureMessage,
  uploadLang,
  type FailedUpload,
} from "@/lib/public-forms/upload-failures"

const passport: FailedUpload = { key: "passport_owner", fileName: "passport.jpg" }
const statement: FailedUpload = { key: "bank_statement", fileName: "2025-statements.pdf" }

describe("shouldBlockSubmission", () => {
  it("does NOT block when every attached file uploaded", () => {
    expect(shouldBlockSubmission([])).toBe(false)
  })

  it("blocks when the only attached file failed", () => {
    expect(shouldBlockSubmission([passport])).toBe(true)
  })

  it("blocks on a PARTIAL failure — the formation-form regression", () => {
    // The original guard was `errors > 0 && paths.length === 0`, so a batch where
    // ANY file succeeded submitted as completed with the others missing. There is
    // no count here to get wrong: one failure blocks.
    expect(shouldBlockSubmission([passport])).toBe(true)
    expect(shouldBlockSubmission([passport, statement])).toBe(true)
  })
})

describe("uploadLang", () => {
  it("returns it only for an exact italian marker", () => {
    expect(uploadLang("it")).toBe("it")
  })
  it("falls back to english for anything else", () => {
    expect(uploadLang("en")).toBe("en")
    expect(uploadLang(null)).toBe("en")
    expect(uploadLang(undefined)).toBe("en")
    expect(uploadLang("IT")).toBe("en")
    expect(uploadLang("")).toBe("en")
  })
})

describe("uploadFailureMessage", () => {
  it("is empty when nothing failed", () => {
    expect(uploadFailureMessage([], "en")).toBe("")
    expect(uploadFailureMessage([], "it")).toBe("")
  })

  it("names the client's own filename, not the storage key", () => {
    const en = uploadFailureMessage([passport], "en")
    expect(en).toContain("passport.jpg")
    expect(en).not.toContain("passport_owner")
  })

  it("names every failed file when several failed", () => {
    const en = uploadFailureMessage([passport, statement], "en")
    expect(en).toContain("passport.jpg")
    expect(en).toContain("2025-statements.pdf")
  })

  it("uses singular vs plural wording correctly, in both languages", () => {
    expect(uploadFailureMessage([passport], "en")).toContain("this file")
    expect(uploadFailureMessage([passport, statement], "en")).toContain("these files")
    expect(uploadFailureMessage([passport], "it")).toContain("questo file")
    expect(uploadFailureMessage([passport, statement], "it")).toContain("questi file")
  })

  it("reassures the client their answers are not lost", () => {
    // The whole case against blocking was "the client loses the form". They do
    // not — and the copy has to say so, or they will believe they did.
    expect(uploadFailureMessage([passport], "en").toLowerCase()).toContain("answers are safe")
    expect(uploadFailureMessage([passport], "it").toLowerCase()).toContain("risposte sono al sicuro")
  })

  it("states plainly that nothing was submitted", () => {
    expect(uploadFailureMessage([passport], "en").toLowerCase()).toContain("nothing has been submitted")
    expect(uploadFailureMessage([passport], "it").toLowerCase()).toContain("non è stato inviato nulla")
  })

  it("offers the escape hatch — remove the file and submit the rest", () => {
    // Without this a client who genuinely cannot upload one file is stranded.
    expect(uploadFailureMessage([passport], "en").toLowerCase()).toContain("remove the file")
    expect(uploadFailureMessage([passport], "it").toLowerCase()).toContain("rimuovi il file")
  })

  it("gives a human to contact", () => {
    expect(uploadFailureMessage([passport], "en")).toContain("support@tonydurante.us")
    expect(uploadFailureMessage([passport], "it")).toContain("support@tonydurante.us")
  })

  it("leaks no internal detail", () => {
    for (const lang of ["en", "it"] as const) {
      const m = uploadFailureMessage([passport, statement], lang).toLowerCase()
      expect(m).not.toMatch(/supabase|postgres|rls|policy|bucket|403|500|violates|row-level/)
    }
  })

  it("english and italian differ (the italian is not an untranslated copy)", () => {
    expect(uploadFailureMessage([passport], "it")).not.toBe(uploadFailureMessage([passport], "en"))
  })

  it("handles an odd filename without producing a broken message", () => {
    const weird: FailedUpload = { key: "k", fileName: "" }
    const m = uploadFailureMessage([weird], "en")
    expect(m).not.toContain("undefined")
    expect(m).not.toContain("[object")
    expect(m).toContain("support@tonydurante.us")
  })
})
