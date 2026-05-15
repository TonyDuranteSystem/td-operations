/* eslint-disable no-console -- CLI debug script, console output is the point */
/**
 * Debug script: download blank IRS forms (W-7, 1040-NR, Schedule OI),
 * enumerate every AcroForm widget annotation, draw a red rectangle around
 * each and write its field name above. Output saved to tmp/ for visual
 * inspection.
 *
 * Used to rebuild the field maps in lib/pdf/w7-fill.ts and
 * lib/pdf/1040nr-fill.ts after we discovered the existing maps are
 * incorrect (Valerio Di Santo's ITIN PDFs landed in the wrong fields).
 *
 * Run with: npx tsx scripts/debug-pdf-fields.ts
 */

import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  PDFArray,
  PDFDict,
  PDFNumber,
  PDFRef,
  rgb,
  StandardFonts,
} from "pdf-lib"
import fs from "fs"
import path from "path"

const FORMS = [
  { name: "w7", url: "https://www.irs.gov/pub/irs-pdf/fw7.pdf" },
  { name: "1040nr", url: "https://www.irs.gov/pub/irs-pdf/f1040nr.pdf" },
  { name: "schedule-oi", url: "https://www.irs.gov/pub/irs-pdf/f1040nro.pdf" },
]

interface FieldInfo {
  name: string
  page: number
  x: number
  y: number
  width: number
  height: number
  subtype: string
}

async function decodeT(value: unknown): Promise<string> {
  if (value instanceof PDFString) return value.decodeText()
  if (value instanceof PDFHexString) return value.decodeText()
  return ""
}

async function annotate(form: typeof FORMS[0]): Promise<FieldInfo[]> {
  console.log(`\n=== ${form.name} ===`)
  const res = await fetch(form.url)
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const pdf = await PDFDocument.load(bytes)
  const font = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pages = pdf.getPages()

  const fieldInfos: FieldInfo[] = []

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex]
    const annotsObj = page.node.lookup(PDFName.of("Annots"))
    if (!(annotsObj instanceof PDFArray)) continue

    const refs: PDFRef[] = []
    annotsObj.asArray().forEach((entry) => {
      if (entry instanceof PDFRef) refs.push(entry)
    })

    for (const ref of refs) {
      const annot = pdf.context.lookup(ref)
      if (!(annot instanceof PDFDict)) continue
      const subtype = annot.lookup(PDFName.of("Subtype"))
      if (!subtype || subtype.toString() !== "/Widget") continue

      // Build full field name by walking parents
      const parts: string[] = []
      let current: PDFDict | undefined = annot
      let safety = 20
      while (current && safety-- > 0) {
        const t = current.lookup(PDFName.of("T"))
        const piece = await decodeT(t)
        if (piece) parts.unshift(piece)
        const parent = current.lookup(PDFName.of("Parent"))
        if (parent instanceof PDFDict) {
          current = parent
        } else if (parent instanceof PDFRef) {
          const resolved = pdf.context.lookup(parent)
          current = resolved instanceof PDFDict ? resolved : undefined
        } else {
          current = undefined
        }
      }
      const fieldName = parts.join(".")

      // Get rectangle
      const rectArr = annot.lookup(PDFName.of("Rect"))
      if (!(rectArr instanceof PDFArray) || rectArr.size() < 4) continue
      const r = [0, 1, 2, 3].map((i) => {
        const v = rectArr.lookup(i)
        return v instanceof PDFNumber ? v.asNumber() : 0
      })
      const x = Math.min(r[0], r[2])
      const y = Math.min(r[1], r[3])
      const width = Math.abs(r[2] - r[0])
      const height = Math.abs(r[3] - r[1])

      // Detect type (Tx=text, Btn=checkbox/button, Ch=choice, Sig=signature)
      let ft = ""
      let cur2: PDFDict | undefined = annot
      let safety2 = 20
      while (cur2 && safety2-- > 0) {
        const f = cur2.lookup(PDFName.of("FT"))
        if (f) {
          ft = f.toString()
          break
        }
        const parent = cur2.lookup(PDFName.of("Parent"))
        if (parent instanceof PDFDict) {
          cur2 = parent
        } else if (parent instanceof PDFRef) {
          const resolved = pdf.context.lookup(parent)
          cur2 = resolved instanceof PDFDict ? resolved : undefined
        } else {
          cur2 = undefined
        }
      }

      fieldInfos.push({
        name: fieldName,
        page: pageIndex,
        x,
        y,
        width,
        height,
        subtype: ft,
      })

      // Draw red rectangle outline
      page.drawRectangle({
        x,
        y,
        width,
        height,
        borderColor: rgb(0.9, 0, 0),
        borderWidth: 0.3,
      })

      // Draw field name label above the rectangle. Shorten obvious prefixes.
      const shortName = fieldName
        .replace(/^topmostSubform\[0\]\./, "")
        .replace(/^form1040-NR\[0\]\./, "")
        .replace(/\[0\]/g, "")
      const labelY = y + height + 1
      page.drawText(shortName, {
        x,
        y: labelY,
        size: 4,
        font,
        color: rgb(0.85, 0, 0),
      })
    }
  }

  const outDir = path.join(process.cwd(), "tmp", "pdf-debug")
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `${form.name}-fields-debug.pdf`)
  fs.writeFileSync(outPath, await pdf.save())
  console.log(`Wrote ${outPath}`)
  console.log(`Total widgets: ${fieldInfos.length}`)

  return fieldInfos
}

async function main() {
  const outDir = path.join(process.cwd(), "tmp", "pdf-debug")
  fs.mkdirSync(outDir, { recursive: true })

  for (const form of FORMS) {
    const infos = await annotate(form)
    const jsonPath = path.join(outDir, `${form.name}-fields.json`)
    fs.writeFileSync(jsonPath, JSON.stringify(infos, null, 2))
    console.log(`Wrote ${jsonPath}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
