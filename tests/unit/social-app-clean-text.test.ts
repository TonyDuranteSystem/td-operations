/**
 * TD Social — cleaning outside text (dev job 2072bc3e, Step 2). A name typed by a person or a client is never trusted as written.
 * The hostile characters are built from code points so no invisible character is typed into this file.
 */
import { describe, it, expect } from "vitest"
import { cleanLabel } from "@/lib/app/clean-text"

const ch = (cp: number) => String.fromCharCode(cp)
const NUL = ch(0x0000)
const ZWSP = ch(0x200b)
const LRM = ch(0x200e)
const RLO = ch(0x202e) // right-to-left override: makes text read backwards
const LRI = ch(0x2066)
const BOM = ch(0xfeff)

describe("cleanLabel", () => {
  it("keeps an ordinary name", () => {
    expect(cleanLabel("Antonio's iPhone", 60)).toBe("Antonio's iPhone")
    expect(cleanLabel("Società Rossi S.r.l. — Milano", 60)).toBe("Società Rossi S.r.l. — Milano")
  })

  it("turns line breaks, tabs and runs of spaces into single spaces", () => {
    expect(cleanLabel("URGENT\n\nwire\t approval", 60)).toBe("URGENT wire approval")
  })

  it("removes control characters and the characters that reverse or hide text", () => {
    expect(cleanLabel(`a${NUL}b${RLO}c${ZWSP}d${LRI}e${BOM}f`, 60)).toBe("a b c d e f")
    expect(cleanLabel(`${RLO}evil`, 60)).toBe("evil")
  })

  it("cuts by whole characters: an emoji is never split", () => {
    const out = cleanLabel("ab😀😀😀", 4)
    expect(out).toBe("ab😀😀")
    expect(Array.from(out)).toHaveLength(4)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false) // no lone surrogate
  })

  it("returns an empty string for anything that is not text", () => {
    for (const v of [undefined, null, 5, {}, [], true]) expect(cleanLabel(v, 10)).toBe("")
  })

  it("a name of only invisible characters becomes empty", () => {
    expect(cleanLabel(`${ZWSP}${LRM}\n `, 10)).toBe("")
  })
})
