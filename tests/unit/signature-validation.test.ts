import { describe, it, expect } from "vitest"
import { isMeaningfulSignature, type SignatureStroke } from "@/lib/signature-validation"

// A single tap → one stroke with one/two points, ~zero extent. This is exactly
// what Numero Uno Social LLC's client submitted, which slipped past isEmpty().
const SINGLE_DOT: SignatureStroke[] = [{ points: [{ x: 120, y: 40 }, { x: 120.5, y: 40.2 }] }]

// A real signature: many points spanning a wide area.
function realSignature(): SignatureStroke[] {
  const points = Array.from({ length: 40 }, (_, i) => ({ x: 20 + i * 4, y: 30 + Math.sin(i / 3) * 12 }))
  return [{ points }]
}

describe("isMeaningfulSignature", () => {
  it("rejects empty / null / no strokes", () => {
    expect(isMeaningfulSignature(null)).toBe(false)
    expect(isMeaningfulSignature(undefined)).toBe(false)
    expect(isMeaningfulSignature([])).toBe(false)
    expect(isMeaningfulSignature([{ points: [] }])).toBe(false)
  })

  it("rejects a single dot / tap (the Numero Uno bug)", () => {
    expect(isMeaningfulSignature(SINGLE_DOT)).toBe(false)
  })

  it("rejects a few stray pixels (enough points but tiny extent)", () => {
    const tinyCluster: SignatureStroke[] = [{ points: Array.from({ length: 10 }, (_, i) => ({ x: 100 + i * 0.5, y: 40 })) }]
    expect(isMeaningfulSignature(tinyCluster)).toBe(false)
  })

  it("accepts a real signature spanning a wide area", () => {
    expect(isMeaningfulSignature(realSignature())).toBe(true)
  })

  it("accepts a multi-stroke signature (e.g. cursive + a dot on the i)", () => {
    const multi: SignatureStroke[] = [
      ...realSignature(),
      { points: [{ x: 200, y: 80 }] }, // the dot — fine because the main stroke qualifies
    ]
    expect(isMeaningfulSignature(multi)).toBe(true)
  })

  it("accepts a tall narrow signature (extent satisfied vertically)", () => {
    const tall: SignatureStroke[] = [{ points: Array.from({ length: 8 }, (_, i) => ({ x: 50, y: 20 + i * 6 })) }]
    expect(isMeaningfulSignature(tall)).toBe(true)
  })
})
