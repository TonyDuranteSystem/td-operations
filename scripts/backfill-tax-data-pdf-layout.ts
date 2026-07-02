/* eslint-disable no-console */
/**
 * Backfill: regenerate Tax_Data summary PDFs whose layout was broken by the
 * fixed-column overlap bug (fixed 2026-07-02, commit 592ef0ff) and by the
 * flattened related-party / alias-noise issues fixed in the same series.
 *
 * For every 2025 tax submission (latest per account+year, completed/reviewed,
 * non-test account) this script regenerates the accountant summary PDF with
 * the CURRENT generator, verifies zero text collisions with pdfjs, and — in
 * --live mode — renames any existing `Tax_Data_<slug>.pdf` in the client's
 * Drive `3. Tax/<year>/` folder to `..._OLD_<date>.pdf` and uploads the
 * corrected file under the canonical name. Old files are renamed, never
 * deleted (audit trail; existing links keep working).
 *
 * DRY-RUN IS THE DEFAULT: generates + verifies everything locally, writes the
 * PDFs and a report to --out (default /tmp/tax-pdf-backfill), touches nothing
 * remote except read-only Drive lookups. Pass --live to mutate Drive.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.json scripts/backfill-tax-data-pdf-layout.ts \
 *     --env /path/to/.env.prod.local [--live] [--account <uuid>] [--limit N] [--out DIR]
 *
 * Requires in the env file: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * (production — Drive is only real there) and GOOGLE_SA_KEY for Drive access.
 */
import fs from "fs"
import path from "path"
import { createClient } from "@supabase/supabase-js"

// ── args ──
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const LIVE = flag("live")
const ENV_PATH = opt("env")
const ONLY_ACCOUNT = opt("account")
const LIMIT = opt("limit") ? Number(opt("limit")) : undefined
const OUT_DIR = opt("out") || "/tmp/tax-pdf-backfill"
const OLD_SUFFIX = `_OLD_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`

if (!ENV_PATH) {
  console.error("Missing --env <path to .env.prod.local>")
  process.exit(1)
}

// ── load env file into process.env (values may be double-quoted) ──
const envText = fs.readFileSync(ENV_PATH, "utf8")
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "")
  }
}
if (process.env.SANDBOX_MODE === "1") {
  console.error("SANDBOX_MODE=1 in the env file — Drive calls would be mocked. Aborting.")
  process.exit(1)
}

// .env.prod.local leaves NEXT_PUBLIC_SUPABASE_URL empty; derive it from
// EXPECTED_SUPABASE_REF when absent.
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  (process.env.EXPECTED_SUPABASE_REF ? `https://${process.env.EXPECTED_SUPABASE_REF}.supabase.co` : "")
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Env file missing NEXT_PUBLIC_SUPABASE_URL (or EXPECTED_SUPABASE_REF) / SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}
console.log(`Target Supabase: ${new URL(SUPABASE_URL).host}  |  mode: ${LIVE ? "LIVE (Drive will be modified)" : "dry-run"}`)

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// ── overlap detector (same geometry check as tests/unit/pdf-field-layout.test.ts) ──
async function countOverlaps(bytes: Uint8Array): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise
  let overlaps = 0
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    const byLine = new Map<number, { x: number; endX: number }[]>()
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue
      const y = Math.round(item.transform[5])
      const row = byLine.get(y) ?? []
      row.push({ x: item.transform[4], endX: item.transform[4] + item.width })
      byLine.set(y, row)
    }
    for (const items of Array.from(byLine.values())) {
      items.sort((a, b) => a.x - b.x)
      for (let i = 1; i < items.length; i++) {
        if (items[i - 1].endX > items[i].x + 0.5) overlaps++
      }
    }
  }
  return overlaps
}

async function withRetry<T>(what: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      console.warn(`  retry ${i + 1}/${tries} for ${what}: ${e instanceof Error ? e.message : String(e)}`)
      await new Promise(r => setTimeout(r, 1000 * (i + 1)))
    }
  }
  throw lastErr
}

async function main() {
  const { generateFormSummaryPDF, normalizeTaxPayloadForPdf, FORM_CONFIGS } = await import("@/lib/form-to-drive")
  const { listFolder, createFolder, uploadBinaryToDrive, renameFile } = await import("@/lib/google-drive")

  // Latest completed/reviewed submission per account+year, non-test accounts.
  const { data: rows, error } = await supabase
    .from("tax_return_submissions")
    .select("id, token, tax_year, status, submitted_data, upload_paths, updated_at, account_id, accounts!inner(company_name, drive_folder_id, is_test)")
    .eq("tax_year", 2025)
    .in("status", ["completed", "reviewed"])
    .order("updated_at", { ascending: false })
  if (error) throw new Error(`query failed: ${error.message}`)

  type Row = {
    id: string; token: string; tax_year: number; status: string
    submitted_data: Record<string, unknown>; upload_paths: string[] | null
    updated_at: string; account_id: string
    accounts: { company_name: string; drive_folder_id: string | null; is_test: boolean }
  }
  const latestPerAccount = new Map<string, Row>()
  for (const r of (rows as unknown as Row[])) {
    if (r.accounts.is_test) continue
    if (ONLY_ACCOUNT && r.account_id !== ONLY_ACCOUNT) continue
    const key = `${r.account_id}:${r.tax_year}`
    if (!latestPerAccount.has(key)) latestPerAccount.set(key, r) // rows sorted desc — first wins
  }
  let items = Array.from(latestPerAccount.values())
  if (LIMIT) items = items.slice(0, LIMIT)
  console.log(`${items.length} account-year packages to process\n`)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const report: Record<string, unknown>[] = []

  for (let idx = 0; idx < items.length; idx++) {
    const r = items[idx]
    const company = r.accounts.company_name
    const slug = (company || r.token).replace(/\s+/g, "_")
    const label = `[${idx + 1}/${items.length}] ${company}`
    try {
      // 1. Regenerate with the CURRENT (fixed) generator
      const normalized = normalizeTaxPayloadForPdf(r.submitted_data || {})
      const bytes = await generateFormSummaryPDF(FORM_CONFIGS.tax_return, normalized, {
        token: r.token,
        submittedAt: r.updated_at,
        companyName: company,
        uploadCount: (r.upload_paths || []).length,
      })

      // 2. Verify geometry
      const overlaps = await countOverlaps(bytes)
      if (overlaps > 0) {
        console.error(`${label}: ✗ generated PDF still has ${overlaps} overlaps — SKIPPED`)
        report.push({ company, submission: r.id, action: "SKIP", reason: `${overlaps} overlaps post-fix` })
        continue
      }
      const localPath = path.join(OUT_DIR, `Tax_Data_${slug}.pdf`)
      fs.writeFileSync(localPath, Buffer.from(bytes))

      // 3. Drive placement
      if (!r.accounts.drive_folder_id) {
        console.warn(`${label}: no drive_folder_id — generated locally only`)
        report.push({ company, submission: r.id, action: "NO_DRIVE_FOLDER", localPath })
        continue
      }

      // Locate (or plan) 3. Tax/<year>/
      const root = await withRetry("listFolder root", () => listFolder(r.accounts.drive_folder_id!))
      const taxFolder = root?.files?.find((f: { name: string; mimeType: string }) => f.name === "3. Tax" && f.mimeType === "application/vnd.google-apps.folder")
      let yearFolderId: string | null = null
      let existing: { id: string; name: string }[] = []
      if (taxFolder) {
        const taxContents = await withRetry("listFolder 3. Tax", () => listFolder(taxFolder.id))
        const yearFolder = taxContents?.files?.find((f: { name: string; mimeType: string }) => f.name === String(r.tax_year) && f.mimeType === "application/vnd.google-apps.folder")
        if (yearFolder) {
          yearFolderId = yearFolder.id
          const yearContents = await withRetry("listFolder year", () => listFolder(yearFolder.id))
          existing = (yearContents?.files || []).filter((f: { name: string }) => f.name === `Tax_Data_${slug}.pdf`)
        }
      }

      if (!LIVE) {
        console.log(`${label}: ✓ ${bytes.length}b, 0 overlaps — would rename ${existing.length} old file(s), upload to ${yearFolderId ? "existing" : "NEW"} 3. Tax/${r.tax_year}/`)
        report.push({ company, submission: r.id, action: "DRY_RUN_OK", bytes: bytes.length, oldFiles: existing.length, yearFolderExists: !!yearFolderId, localPath })
        continue
      }

      // 4. LIVE: create folders if missing, rename olds, upload
      let targetId = yearFolderId
      if (!targetId) {
        const taxId = taxFolder?.id || (await withRetry("create 3. Tax", () => createFolder(r.accounts.drive_folder_id!, "3. Tax"))).id
        targetId = (await withRetry("create year", () => createFolder(taxId, String(r.tax_year)))).id
      }
      for (const f of existing) {
        await withRetry(`rename ${f.id}`, () => renameFile(f.id, `Tax_Data_${slug}${OLD_SUFFIX}.pdf`))
      }
      const uploaded = await withRetry("upload", () => uploadBinaryToDrive(`Tax_Data_${slug}.pdf`, Buffer.from(bytes), "application/pdf", targetId!))
      console.log(`${label}: ✓ uploaded ${uploaded.id} (renamed ${existing.length} old)`)
      report.push({ company, submission: r.id, action: "UPLOADED", fileId: uploaded.id, renamedOld: existing.length })
      await new Promise(res => setTimeout(res, 300))
    } catch (e) {
      console.error(`${label}: ✗ ${e instanceof Error ? e.message : String(e)}`)
      report.push({ company, submission: r.id, action: "ERROR", error: e instanceof Error ? e.message : String(e) })
    }
  }

  const reportPath = path.join(OUT_DIR, `report-${LIVE ? "live" : "dry-run"}.json`)
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  const counts: Record<string, number> = {}
  for (const row of report) counts[row.action as string] = (counts[row.action as string] || 0) + 1
  console.log(`\nDone. ${JSON.stringify(counts)}  → ${reportPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
