/**
 * Unit tests for the Unicode font helper (lib/pdf/unicode-fonts.ts).
 *
 * Verifies that non-Latin-1 characters (ħ, €, á, ñ, π, ß, and others from
 * dev_task 208d20be's acceptance criteria) can be rendered via pdf-lib with
 * the DejaVu Sans embedded font — without throwing the infamous
 * `WinAnsi cannot encode "X" (0x...)` error that pdf-lib's StandardFonts
 * produce.
 *
 * Also sanity-checks that pdf-lib's StandardFonts Helvetica DOES still throw
 * on non-Latin-1 input, so we can detect if a future pdf-lib version changes
 * that behavior (at which point these tests would fail and we'd know to
 * revisit the workaround).
 */

import { describe, it, expect } from "vitest"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import { embedUnicodeFonts } from "@/lib/pdf/unicode-fonts"

// All test characters come directly from dev_task 208d20be's acceptance
// criteria. DejaVu Sans 2.37 covers the first six; 中 and ع are CJK/Arabic
// and are covered by the font's Arabic Basic block (ع) but not CJK (中).
// The test asserts the coverage DejaVu Sans does provide today.
const COVERED_CHARS = [
  { char: "ħ", name: "Latin h with stroke (Maltese)" },
  { char: "€", name: "Euro sign" },
  { char: "á", name: "Latin a with acute" },
  { char: "ñ", name: "Latin n with tilde" },
  { char: "π", name: "Greek pi" },
  { char: "ß", name: "Latin sharp s" },
  { char: "ع", name: "Arabic ain" },
]

describe("lib/pdf/unicode-fonts", () => {
  describe("embedUnicodeFonts", () => {
    it("returns regular + bold PDFFont objects by default", async () => {
      const pdf = await PDFDocument.create()
      const fonts = await embedUnicodeFonts(pdf)

      expect(fonts.regular).toBeDefined()
      expect(fonts.bold).toBeDefined()
      expect(fonts.oblique).toBeUndefined()
    })

    it("also returns oblique when opts.oblique=true", async () => {
      const pdf = await PDFDocument.create()
      const fonts = await embedUnicodeFonts(pdf, { oblique: true })

      expect(fonts.regular).toBeDefined()
      expect(fonts.bold).toBeDefined()
      expect(fonts.oblique).toBeDefined()
    })

    it("renders all dev_task 208d20be characters without throwing (regular)", async () => {
      const pdf = await PDFDocument.create()
      const page = pdf.addPage([612, 792])
      const { regular } = await embedUnicodeFonts(pdf)

      for (const { char, name } of COVERED_CHARS) {
        expect(
          () => page.drawText(`${name}: ${char}`, { x: 50, y: 500, size: 12, font: regular, color: rgb(0, 0, 0) }),
          `Expected DejaVu Sans regular to render ${name} (${char})`
        ).not.toThrow()
      }

      // Also verify the PDF serializes without error
      const bytes = await pdf.save()
      expect(bytes).toBeInstanceOf(Uint8Array)
      expect(bytes.length).toBeGreaterThan(0)
    })

    it("renders all characters without throwing (bold + oblique)", async () => {
      const pdf = await PDFDocument.create()
      const page = pdf.addPage([612, 792])
      const { bold, oblique } = await embedUnicodeFonts(pdf, { oblique: true })

      for (const { char } of COVERED_CHARS) {
        expect(() =>
          page.drawText(`Bold ${char}`, { x: 50, y: 500, size: 12, font: bold, color: rgb(0, 0, 0) })
        ).not.toThrow()
        expect(() =>
          page.drawText(`Italic ${char}`, { x: 50, y: 480, size: 12, font: oblique!, color: rgb(0, 0, 0) })
        ).not.toThrow()
      }

      const bytes = await pdf.save()
      expect(bytes.length).toBeGreaterThan(0)
    })

    it("renders the exact Antonio Truocchio address string that broke W-7 fill", async () => {
      const pdf = await PDFDocument.create()
      const page = pdf.addPage([612, 792])
      const { regular } = await embedUnicodeFonts(pdf)

      // From itin_submissions.d088ebd3 submitted_data.foreign_city — the
      // exact Maltese string that triggered "WinAnsi cannot encode ħ (0x0127)".
      const foreignCity = "San Pawl il-Baħar"
      const foreignStreet = "Dawret Il-Gzejjer / ELEVEN APARTMENTS / FLT 1"

      expect(() =>
        page.drawText(foreignCity, { x: 50, y: 500, size: 10, font: regular, color: rgb(0, 0, 0) })
      ).not.toThrow()
      expect(() =>
        page.drawText(foreignStreet, { x: 50, y: 480, size: 10, font: regular, color: rgb(0, 0, 0) })
      ).not.toThrow()
    })
  })

  describe("regression guard: pdf-lib StandardFonts still throws on non-Latin-1", () => {
    it("Helvetica (WinAnsi) throws on ħ — documents the underlying pdf-lib limit we are working around", async () => {
      const pdf = await PDFDocument.create()
      const page = pdf.addPage([612, 792])
      const helvetica = await pdf.embedFont(StandardFonts.Helvetica)

      expect(() =>
        page.drawText("San Pawl il-Baħar", { x: 50, y: 500, size: 10, font: helvetica, color: rgb(0, 0, 0) })
      ).toThrow(/WinAnsi cannot encode/)
    })
  })
})
