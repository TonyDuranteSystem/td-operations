/* eslint-disable no-console -- CLI rescue script, console output is the point */
/**
 * Local regeneration of Valerio Di Santo's ITIN PDFs using the fixed
 * lib/pdf/w7-fill.ts and lib/pdf/1040nr-fill.ts. Output goes to
 * tmp/pdf-debug/ for visual + OCR verification BEFORE any deploy.
 *
 * Run with: npx tsx scripts/regenerate-valerio-pdfs.ts
 */

import fs from "fs"
import path from "path"
import { fillW7 } from "../lib/pdf/w7-fill"
import { fill1040NR, fillScheduleOI } from "../lib/pdf/1040nr-fill"

// Exact data Valerio submitted via the portal wizard on 2026-05-13
// (preserved in wizard_progress.data, row 5ea1d84a-46fd-4039-a8b3-4bb0cc9ea9b7).
const valerio = {
  first_name: "Valerio",
  last_name: "Di Santo",
  foreign_street: "Calle Italia 6",
  foreign_city: "Costa Adeje",
  foreign_state_province: "Santa Cruz de Tenerife",
  foreign_zip: "38660",
  foreign_country: "Spain",
  dob: "2002-12-11",
  country_of_birth: "Italy",
  city_of_birth: "Rome",
  gender: "Male" as const,
  citizenship: "Italy",
  foreign_tax_id: "Z2304400-N",
  passport_number: "YB8985237",
  passport_country: "Italy",
  passport_expiry: "2031-12-15",
  has_previous_itin: false,
}

async function main() {
  const outDir = path.join(process.cwd(), "tmp", "pdf-debug", "valerio-rerun")
  fs.mkdirSync(outDir, { recursive: true })

  console.log("Generating W-7...")
  const w7 = await fillW7(valerio)
  fs.writeFileSync(path.join(outDir, "W-7_Valerio_Di_Santo.pdf"), w7)

  console.log("Generating 1040-NR...")
  const nr = await fill1040NR(valerio)
  fs.writeFileSync(path.join(outDir, "1040-NR_Valerio_Di_Santo.pdf"), nr)

  console.log("Generating Schedule OI...")
  const oi = await fillScheduleOI(valerio)
  fs.writeFileSync(path.join(outDir, "Schedule_OI_Valerio_Di_Santo.pdf"), oi)

  console.log(`\nOutput: ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
