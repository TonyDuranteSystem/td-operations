import { describe, it, expect } from "vitest"
import { guessMessageLocale } from "@/lib/messaging/lang-detect"

describe("guessMessageLocale", () => {
  it("recognises clear Italian", () => {
    expect(guessMessageLocale("Ciao Luca, grazie mille per il messaggio, a domani!")).toBe("it")
  })
  it("recognises clear English", () => {
    expect(guessMessageLocale("Hi Luca, thanks so much for the message, see you tomorrow!")).toBe("en")
  })
  it("handles accented Italian the same as unaccented", () => {
    expect(guessMessageLocale("Non so perche' non funziona, potrebbe aiutarmi?")).toBe("it")
    expect(guessMessageLocale("Non so perché non funziona, potrebbe aiutarmi?")).toBe("it")
  })
  it("returns null on empty, emoji-only, or ambiguous text", () => {
    expect(guessMessageLocale("")).toBeNull()
    expect(guessMessageLocale("👍🎉")).toBeNull()
    expect(guessMessageLocale("123 456")).toBeNull()
    expect(guessMessageLocale(null)).toBeNull()
    expect(guessMessageLocale(undefined)).toBeNull()
  })
  it("returns null on a genuine tie rather than guessing", () => {
    expect(guessMessageLocale("hi ciao")).toBeNull()
  })
  it("never throws on garbage input", () => {
    expect(() => guessMessageLocale("�".repeat(50))).not.toThrow()
    expect(() => guessMessageLocale("\n\n\t\t")).not.toThrow()
  })
})
