import { describe, it, expect } from "vitest"
import {
  normalizeResetEmail,
  truncateForLog,
  buildResetEmailContent,
  MAX_LOGGED_EMAIL_LENGTH,
} from "@/lib/portal/password-reset"

describe("normalizeResetEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeResetEmail("  Chiara.Fazzini@Gmail.COM ")).toBe(
      "chiara.fazzini@gmail.com",
    )
  })

  it("handles null and undefined without throwing", () => {
    expect(normalizeResetEmail(null)).toBe("")
    expect(normalizeResetEmail(undefined)).toBe("")
  })

  it("returns empty for whitespace-only input", () => {
    expect(normalizeResetEmail("   ")).toBe("")
  })

  it("agrees with the lookup helper's own normalization", () => {
    // findAuthUserByEmail lowercases + trims internally. If these two ever drift,
    // the address we LOG and RATE-KEY stops matching the one we LOOK UP, and the
    // audit row becomes misleading — the exact failure this module exists to end.
    const raw = "  MiXeD@Example.COM  "
    expect(normalizeResetEmail(raw)).toBe(raw.toLowerCase().trim())
  })
})

describe("truncateForLog", () => {
  it("leaves a normal address untouched", () => {
    expect(truncateForLog("uxio74@gmail.com")).toBe("uxio74@gmail.com")
  })

  it("caps attacker-controlled input at the max length", () => {
    const huge = "a".repeat(5000) + "@example.com"
    expect(truncateForLog(huge)).toHaveLength(MAX_LOGGED_EMAIL_LENGTH)
  })
})

describe("buildResetEmailContent", () => {
  const resetUrl = "https://portal.tonydurante.us/verify?token=abc123"

  it("writes Italian copy and an Italian subject for an Italian client", () => {
    const { subject, html } = buildResetEmailContent({
      fullName: "Chiara Fazzini",
      locale: "it",
      resetUrl,
    })
    expect(subject).toContain("Reimposta la password")
    expect(html).toContain("Ciao Chiara Fazzini")
    expect(html).toContain("Reimposta la password")
    // No English leaking into the Italian version — the whole point.
    expect(html).not.toContain("Reset my password")
  })

  it("writes English copy for everyone else", () => {
    const { subject, html } = buildResetEmailContent({
      fullName: "Uxio Test",
      locale: "en",
      resetUrl,
    })
    expect(subject).toContain("Reset your Portal password")
    expect(html).toContain("Hi Uxio Test")
    expect(html).not.toContain("Reimposta")
  })

  it("always carries the reset link", () => {
    for (const locale of ["it", "en"] as const) {
      const { html } = buildResetEmailContent({
        fullName: null,
        locale,
        resetUrl,
      })
      expect(html).toContain(resetUrl)
    }
  })

  it("degrades gracefully when the client has no name on file", () => {
    // Teammate logins have no contacts row at all, so fullName is legitimately
    // null — the email must still be sendable, not render "Hi null".
    const en = buildResetEmailContent({ fullName: null, locale: "en", resetUrl })
    expect(en.html).toContain("Hi there")
    expect(en.html).not.toContain("null")

    const it = buildResetEmailContent({ fullName: null, locale: "it", resetUrl })
    expect(it.html).not.toContain("null")
    expect(it.html).toContain("Ciao")
  })

  it("is branded as Tony Durante LLC, not the auth provider", () => {
    // The defect that started this: the client received mail from "Supabase Auth",
    // a sender she had never seen, and never recognised it as us.
    const { html } = buildResetEmailContent({
      fullName: "Chiara Fazzini",
      locale: "it",
      resetUrl,
    })
    expect(html).toContain("Tony Durante LLC")
    expect(html.toLowerCase()).not.toContain("supabase")
  })

  it("tells the client the link is single-use and expiring, in both languages", () => {
    expect(
      buildResetEmailContent({ fullName: null, locale: "en", resetUrl }).html,
    ).toMatch(/expires|once/i)
    expect(
      buildResetEmailContent({ fullName: null, locale: "it", resetUrl }).html,
    ).toMatch(/scade|una sola volta/i)
  })
})
