import { describe, it, expect } from "vitest"
import { previewKind } from "@/lib/crm-storage/preview-kind"

describe("previewKind", () => {
  it("classifies a null mime type as unpreviewable", () => {
    expect(previewKind(null)).toBe("none")
  })

  it("classifies an empty string as unpreviewable", () => {
    expect(previewKind("")).toBe("none")
  })

  it("classifies image/* as image", () => {
    expect(previewKind("image/png")).toBe("image")
    expect(previewKind("image/jpeg")).toBe("image")
  })

  it("classifies exactly application/pdf as pdf", () => {
    expect(previewKind("application/pdf")).toBe("pdf")
  })

  it("does not classify a near-miss pdf mime type as pdf", () => {
    // Regression guard: previewKind uses an exact match for PDF, not a
    // prefix match like the other kinds — a mime type that merely contains
    // "pdf" must not accidentally render in the PDF iframe branch.
    expect(previewKind("application/x-pdf")).toBe("none")
  })

  it("classifies video/* as video", () => {
    expect(previewKind("video/mp4")).toBe("video")
  })

  it("classifies audio/* as audio", () => {
    expect(previewKind("audio/mpeg")).toBe("audio")
  })

  it("classifies text/* as text", () => {
    expect(previewKind("text/plain")).toBe("text")
    expect(previewKind("text/csv")).toBe("text")
  })

  it("classifies an unrecognized mime type as none", () => {
    expect(previewKind("application/zip")).toBe("none")
    expect(previewKind("application/msword")).toBe("none")
  })

  it("a prefix-matched kind (text/video/audio/image) still matches with parameters", () => {
    expect(previewKind("text/plain; charset=utf-8")).toBe("text")
  })

  it("a parameterized pdf mime type does NOT match — only the exact string does", () => {
    // previewKind uses an exact match for pdf but a prefix match for the
    // other four kinds — an inconsistency worth documenting: a real
    // "application/pdf; charset=binary" (a parameterized value some tools
    // emit) would fall through to "no preview" even though it's a real PDF.
    expect(previewKind("application/pdf; charset=binary")).toBe("none")
  })
})
