import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * The ITIN-letter reader AS PRODUCTION BUILDS IT. On 2026-11-08 the live CRM read the ITIN from a letter but NEVER a date: Next 14's production
 * compiler (SWC with the minifier on) folded the template-string regex `\\b${MONTH_RE}…` and wrote the word boundary as a backspace character, so
 * the date pattern matched nothing — while every unit test, the dev server and the sandbox read the same letter fine (they run the source as written).
 * This test compiles the reader with Next's own compiler, minified, for the targets that matter, runs the COMPILED code, and asks for the dates.
 * It fails the day a compiler change (or a new template-string regex) breaks the reader again.
 */
const SOURCE = readFileSync(path.join(process.cwd(), "lib/itin/read-itin-letter.ts"), "utf8")

// the text the real reading service returned for a made-up CP565A (no real person)
const LETTER = [
  "Department of the Treasury", "Internal Revenue Service", "PO Box 149342", "Austin, TX 78714-9342", "IRS Notice CP565A",
  "Case Reference Number: 20294-245-01413-5", "Date of Birth: June 9, 1988", "MARCO ROSSI", "14 TEST STREET STE B200", "IRVINE CA 92618", "October 7, 2025",
  "You've been assigned an Individual Taxpayer Identification Number (ITIN)",
  "This notice confirms your assigned ITIN 900-70-0001. Review your ITIN and personal information in the table below.",
  "Your ITIN and personal information", "ITIN", "900-70-0001", "Full name (First, Middle, Last)", "MARCO, ROSSI", "Date of Birth", "June 9, 1988",
].join("\n")

type Reader = typeof import("@/lib/itin/read-itin-letter").readItinLetter

async function compiledReader(target: "es2017" | "es5"): Promise<Reader> {
  const { transform } = await import("next/dist/build/swc")
  const out = await transform(SOURCE, {
    filename: "read-itin-letter.ts",
    jsc: { parser: { syntax: "typescript" }, target, minify: { compress: true, mangle: true } },
    module: { type: "commonjs" },
    minify: true,
    sourceMaps: false,
  })
  const mod = { exports: {} as Record<string, unknown> }
  new Function("module", "exports", "require", out.code)(mod, mod.exports, () => { throw new Error("the reader must not import anything") })
  return mod.exports.readItinLetter as Reader
}

describe("the ITIN-letter reader, compiled the way production compiles it", () => {
  for (const target of ["es2017", "es5"] as const) {
    it(`target ${target}: the notice date and the date of birth are read (not just the ITIN)`, async () => {
      const read = await compiledReader(target)
      const r = read(LETTER, new Date("2026-11-08T12:00:00Z"))
      expect(r.itin.value).toBe("900-70-0001")
      expect(r.noticeDate).toMatchObject({ value: "2025-10-07", status: "ok" })
      expect(r.dateOfBirth).toMatchObject({ value: "1988-06-09" })
      expect(r.problems).toEqual([])
    })
  }
})
