import { describe, it, expect } from "vitest"
import { resolveSignatureImagePath } from "@/lib/oa/signature-image-path"

const T = "acme-llc-oa-2026"

describe("resolveSignatureImagePath", () => {
  it("accepts the member's own picture, with or without the older suffix", () => {
    expect(resolveSignatureImagePath(T, 0, `${T}/sig-0.png`)).toEqual({ ok: true, path: `${T}/sig-0.png` })
    expect(resolveSignatureImagePath(T, 1, `${T}/sig-1-mrva3cle.png`).ok).toBe(true)
    expect(resolveSignatureImagePath(T, 12, `${T}/sig-12.png`).ok).toBe(true)
  })
  it("refuses another member's picture (including index prefix tricks)", () => {
    expect(resolveSignatureImagePath(T, 1, `${T}/sig-0.png`).ok).toBe(false)
    expect(resolveSignatureImagePath(T, 1, `${T}/sig-12.png`).ok).toBe(false)
    expect(resolveSignatureImagePath(T, 12, `${T}/sig-1.png`).ok).toBe(false)
  })
  it("refuses another agreement's folder, nested paths, traversal and non-PNG", () => {
    expect(resolveSignatureImagePath(T, 0, "other-llc-oa-2026/sig-0.png").ok).toBe(false)
    expect(resolveSignatureImagePath(T, 0, `${T}/sub/sig-0.png`).ok).toBe(false)
    expect(resolveSignatureImagePath(T, 0, `${T}/../x/sig-0.png`).ok).toBe(false)
    expect(resolveSignatureImagePath(T, 0, `${T}/sig-0.pdf`).ok).toBe(false)
    expect(resolveSignatureImagePath(T, 0, `${T}/sig-0-a.b.png`).ok).toBe(false)
  })
  it("refuses empty, missing token and bad index", () => {
    expect(resolveSignatureImagePath(T, 0, null).ok).toBe(false)
    expect(resolveSignatureImagePath("", 0, `${T}/sig-0.png`).ok).toBe(false)
    expect(resolveSignatureImagePath(T, -1, `${T}/sig--1.png`).ok).toBe(false)
    expect(resolveSignatureImagePath(T, 1.5, `${T}/sig-1.png`).ok).toBe(false)
  })
})
