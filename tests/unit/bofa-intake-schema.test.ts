import { describe, it, expect } from "vitest"
import {
  BOFA_DOC_SLOTS,
  BOFA_TEXT_FIELDS,
  buildUploadPath,
  effectiveMime,
  isAllowedMime,
  pathBelongsToLink,
  safeFileName,
  validateSubmission,
} from "@/lib/bofa-intake/schema"

const TOKEN = "tok_abcdefghijklmnopqrstuvwx"

function goodData(): Record<string, string> {
  const d: Record<string, string> = {}
  for (const f of BOFA_TEXT_FIELDS) d[f.key] = "x"
  d.email = "jordan@example.com"
  d.monthly_deposits = "Under $5,000"
  return d
}
function goodFiles() {
  return BOFA_DOC_SLOTS.filter((s) => s.required).map((s) => ({
    key: s.key,
    name: `${s.key}.pdf`,
    path: buildUploadPath(TOKEN, s.key, "11111111", `${s.key}.pdf`),
  }))
}

describe("bofa intake validation", () => {
  it("accepts a complete submission", () => {
    const r = validateSubmission(goodData(), goodFiles(), TOKEN)
    expect(r.ok).toBe(true)
  })

  it("rejects a missing required text field and names it", () => {
    const d = goodData()
    d.home_zip = "  "
    const r = validateSubmission(d, goodFiles(), TOKEN)
    expect(r).toEqual({ ok: false, error: "Home address: zip code is required." })
  })

  it("allows the website to be empty", () => {
    const d = goodData()
    d.website = ""
    expect(validateSubmission(d, goodFiles(), TOKEN).ok).toBe(true)
  })

  it("rejects a bad email and an unknown deposit range", () => {
    const d = goodData()
    d.email = "not-an-email"
    expect(validateSubmission(d, goodFiles(), TOKEN).ok).toBe(false)
    const e = goodData()
    e.monthly_deposits = "a lot"
    expect(validateSubmission(e, goodFiles(), TOKEN).ok).toBe(false)
  })

  it("rejects when a required document is missing", () => {
    const files = goodFiles().filter((f) => f.key !== "lease")
    expect(validateSubmission(goodData(), files, TOKEN)).toEqual({ ok: false, error: "Lease agreement is required." })
  })

  it("rejects a file path that belongs to another link or another slot", () => {
    const files = goodFiles()
    files[0] = { ...files[0], path: buildUploadPath("tok_someoneelse_zzzzzzzzzzzz", files[0].key, "1", "a.pdf") }
    expect(validateSubmission(goodData(), files, TOKEN).ok).toBe(false)
    const files2 = goodFiles()
    files2[0] = { ...files2[0], path: buildUploadPath(TOKEN, "lease", "1", "a.pdf") }
    expect(validateSubmission(goodData(), files2, TOKEN).ok).toBe(false)
  })

  it("rejects an unknown document slot and path traversal", () => {
    const files = [...goodFiles(), { key: "selfie", name: "a.pdf", path: `${TOKEN}/selfie/a.pdf` }]
    expect(validateSubmission(goodData(), files, TOKEN).ok).toBe(false)
    expect(pathBelongsToLink(`${TOKEN}/passport/../../x`, TOKEN, "passport")).toBe(false)
  })

  it("rejects empty or non-object input", () => {
    expect(validateSubmission(null, [], TOKEN).ok).toBe(false)
    expect(validateSubmission(goodData(), "nope", TOKEN).ok).toBe(false)
  })

  it("rejects two documents in the same box", () => {
    const files = goodFiles()
    files.push({ ...files[0], path: buildUploadPath(TOKEN, files[0].key, "22222222", "again.pdf") })
    expect(validateSubmission(goodData(), files, TOKEN)).toEqual({ ok: false, error: "Upload one document per box." })
  })

  it("rejects more documents than there are boxes", () => {
    const files = goodFiles()
    for (let i = 0; i < BOFA_DOC_SLOTS.length; i++) files.push({ ...files[0], path: buildUploadPath(TOKEN, files[0].key, `x${i}`, "a.pdf") })
    expect(validateSubmission(goodData(), files, TOKEN)).toEqual({ ok: false, error: "Too many documents." })
  })

  it("rejects overlong answers", () => {
    const d = goodData()
    d.business_description = "a".repeat(4001)
    expect(validateSubmission(d, goodFiles(), TOKEN).ok).toBe(false)
  })
})

describe("bofa intake file helpers", () => {
  it("strips spaces and odd characters from file names (storage keys reject them)", () => {
    expect(safeFileName("My Passport (1).pdf")).toBe("My_Passport_1_.pdf")
    expect(safeFileName("///")).toBe("file")
    expect(buildUploadPath(TOKEN, "passport", "u1", "a b.pdf")).toBe(`${TOKEN}/passport/u1-a_b.pdf`)
  })

  it("falls back to the extension when a browser reports no type (iPhone .heic on some browsers)", () => {
    expect(effectiveMime("IMG_0042.HEIC", "")).toBe("image/heic")
    expect(effectiveMime("scan.pdf", "")).toBe("application/pdf")
    expect(effectiveMime("notes.txt", "")).toBe("")
    expect(effectiveMime("photo.heic", "image/jpeg")).toBe("image/jpeg")
    expect(isAllowedMime(effectiveMime("page.html", ""))).toBe(false)
  })

  it("allows PDFs and photos only", () => {
    expect(isAllowedMime("application/pdf")).toBe(true)
    expect(isAllowedMime("image/JPEG")).toBe(true)
    expect(isAllowedMime("text/html")).toBe(false)
    expect(isAllowedMime("image/svg+xml")).toBe(false)
  })
})
