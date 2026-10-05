import { describe, it, expect } from "vitest"
import { signedPdfGate } from "@/lib/oa/signed-pdf-gate"

const TOKEN = "acme-llc-oa-2026"
const PATH = `${TOKEN}/oa-signed-1777451932307.pdf`

describe("signedPdfGate", () => {
  it("hands out the recorded file of a signed agreement", () => {
    const r = signedPdfGate({ token: TOKEN, status: "signed", pdf_storage_path: PATH })
    expect(r.ok).toBe(true)
    expect(r.path).toBe(PATH)
    expect(r.error).toBeNull()
  })
  it("refuses an agreement that is not signed yet, with the 'ready once every member has signed' wording", () => {
    for (const status of ["draft", "sent", "viewed", null]) {
      const r = signedPdfGate({ token: TOKEN, status, pdf_storage_path: PATH })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(409)
      expect(r.error).toMatch(/every member has signed/)
    }
  })
  it("refuses a voided agreement even if a signed file is recorded", () => {
    const r = signedPdfGate({ token: TOKEN, status: "voided", pdf_storage_path: PATH })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(410)
  })
  it("a signed agreement with no recorded file is a 404 that does NOT claim members still have to sign", () => {
    const r = signedPdfGate({ token: TOKEN, status: "signed", pdf_storage_path: null })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
    expect(r.error).not.toMatch(/every member has signed/)
  })
  it("never serves a path outside the agreement's own folder or a non-PDF", () => {
    expect(signedPdfGate({ token: TOKEN, status: "signed", pdf_storage_path: "other-llc-oa-2026/oa-signed-1.pdf" }).ok).toBe(false)
    expect(signedPdfGate({ token: TOKEN, status: "signed", pdf_storage_path: `${TOKEN}/signature.png` }).ok).toBe(false)
    expect(signedPdfGate({ token: TOKEN, status: "signed", pdf_storage_path: `${TOKEN}/sub/x.pdf` }).ok).toBe(false)
  })
})
