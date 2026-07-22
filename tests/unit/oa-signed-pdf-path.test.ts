/**
 * lib/oa/signed-pdf-path.ts — which stored object gets filed as the executed
 * operating agreement.
 *
 * The bug these tests lock shut: the publish step listed the agreement's storage
 * folder, took the NEWEST object, and filed it to the client's Google Drive
 * (upsert — overwriting the real one) and their portal. The bucket's only policy
 * is INSERT for role `public`, so anyone can upload into it with no credential,
 * and tokens are derivable from a public company name. "Newest wins" therefore
 * meant: upload a PDF into a guessed folder, poke the unauthenticated publish
 * route, and TD files YOUR document as the client's executed agreement.
 *
 * The regression that must never come back is a FALLBACK. If the recorded path
 * is missing or wrong, the answer is "file nothing" — never "go and look".
 */

import { describe, it, expect } from "vitest"
import { resolveSignedPdfPath, signedPdfPathProblem } from "@/lib/oa/signed-pdf-path"

const TOKEN = "acme-llc-oa-2026"

describe("resolveSignedPdfPath — the happy path", () => {
  it("returns the recorded path when it sits in the agreement's own folder", () => {
    const r = resolveSignedPdfPath(TOKEN, `${TOKEN}/oa-signed-1784676141368.pdf`)
    expect(r).toEqual({ ok: true, path: `${TOKEN}/oa-signed-1784676141368.pdf`, reason: null })
  })

  it("returns the TRIMMED path, not merely ok, for a padded stored value", () => {
    // Asserting only `ok` here would miss the single failure mode the trim
    // exists to prevent: an untrimmed path 404s at the storage download.
    const r = resolveSignedPdfPath(TOKEN, `  ${TOKEN}/oa-signed-1.pdf  `)
    expect(r.path).toBe(`${TOKEN}/oa-signed-1.pdf`)
  })

  it("accepts an uppercase extension", () => {
    expect(resolveSignedPdfPath(TOKEN, `${TOKEN}/OA-SIGNED.PDF`).ok).toBe(true)
  })
})

describe("resolveSignedPdfPath — refuses rather than guesses", () => {
  it.each([null, undefined, "", "   "])("refuses when the recorded path is %p", p => {
    const r = resolveSignedPdfPath(TOKEN, p as unknown as string)
    expect(r).toEqual({ ok: false, path: null, reason: "missing" })
  })

  it("refuses when there is no token to scope the path to", () => {
    expect(resolveSignedPdfPath(null, "anything.pdf")).toEqual({ ok: false, path: null, reason: "missing" })
    expect(resolveSignedPdfPath("", `${TOKEN}/x.pdf`)).toEqual({ ok: false, path: null, reason: "missing" })
  })

  it("NEVER falls back to a folder scan — a missing path yields no path at all", () => {
    // The whole vulnerability was a fallback. There must be no shape of input
    // that produces "go and look in the folder".
    const r = resolveSignedPdfPath(TOKEN, null)
    expect(r.ok).toBe(false)
    expect(r.path).toBeNull()
  })
})

describe("resolveSignedPdfPath — the path must belong to THIS agreement", () => {
  it("rejects another agreement's folder", () => {
    expect(resolveSignedPdfPath(TOKEN, "other-llc-oa-2026/oa-signed.pdf")).toEqual({
      ok: false,
      path: null,
      reason: "outside_agreement",
    })
  })

  it("rejects a token that is merely a prefix of another folder", () => {
    // "acme-llc-oa-2026" must not match "acme-llc-oa-2026-old/..."
    expect(resolveSignedPdfPath(TOKEN, `${TOKEN}-old/oa-signed.pdf`).ok).toBe(false)
  })

  it("rejects traversal out of the folder", () => {
    expect(resolveSignedPdfPath(TOKEN, `${TOKEN}/../other/oa.pdf`)).toEqual({
      ok: false,
      path: null,
      reason: "outside_agreement",
    })
  })

  it("ACCEPTS a legitimate filename containing two dots", () => {
    // Guard against re-adding a `..` substring check: it cannot escape the
    // folder (the separator check already blocks that) and it would reject
    // this while logging a reason that misdirects the investigator.
    expect(resolveSignedPdfPath(TOKEN, `${TOKEN}/oa-signed..pdf`).ok).toBe(true)
  })

  it("rejects a nested subfolder — the signing page never creates one", () => {
    expect(resolveSignedPdfPath(TOKEN, `${TOKEN}/sub/oa-signed.pdf`)).toEqual({
      ok: false,
      path: null,
      reason: "outside_agreement",
    })
  })

  it("rejects a bare filename with no folder", () => {
    expect(resolveSignedPdfPath(TOKEN, "oa-signed.pdf").ok).toBe(false)
  })

  it("rejects an absolute or bucket-qualified path", () => {
    expect(resolveSignedPdfPath(TOKEN, `/${TOKEN}/oa.pdf`).ok).toBe(false)
    expect(resolveSignedPdfPath(TOKEN, `signed-oa/${TOKEN}/oa.pdf`).ok).toBe(false)
  })

  it("rejects the folder itself", () => {
    expect(resolveSignedPdfPath(TOKEN, `${TOKEN}/`).ok).toBe(false)
  })
})

describe("resolveSignedPdfPath — must be a PDF", () => {
  it("rejects a signature image pointed at by a poisoned value", () => {
    // The signature PNGs live in the SAME folder, so a poisoned path could
    // otherwise file a member's signature image as the executed agreement.
    expect(resolveSignedPdfPath(TOKEN, `${TOKEN}/sig-0.png`)).toEqual({ ok: false, path: null, reason: "not_pdf" })
  })

  it("rejects anything else in the folder", () => {
    expect(resolveSignedPdfPath(TOKEN, `${TOKEN}/notes.txt`).ok).toBe(false)
    expect(resolveSignedPdfPath(TOKEN, `${TOKEN}/oa-signed.pdf.exe`).ok).toBe(false)
  })
})

describe("signedPdfPathProblem", () => {
  it("explains each refusal for the operator log", () => {
    for (const reason of ["missing", "outside_agreement", "not_pdf"] as const) {
      const msg = signedPdfPathProblem(reason)
      expect(msg.length).toBeGreaterThan(20)
      expect(msg).not.toContain("undefined")
    }
  })

  it("gives a DISTINCT message per reason", () => {
    // Collapsing all three to one generic string would pass the assertions
    // above while destroying the point of the log.
    const msgs = (["missing", "outside_agreement", "not_pdf"] as const).map(signedPdfPathProblem)
    expect(new Set(msgs).size).toBe(3)
  })

  it("says plainly that nothing was filed when there is no path", () => {
    expect(signedPdfPathProblem("missing").toLowerCase()).toContain("nothing filed")
  })
})
