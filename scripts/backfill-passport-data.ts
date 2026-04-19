/* eslint-disable no-console -- CLI tool, stdout IS the UI */
/**
 * One-off batch backfill: run OCR on every contact that has a passport
 * uploaded (documents.document_type_name='Passport') but no
 * passport_number / passport_expiry_date extracted yet.
 *
 * Targets ~66 contacts hit by the pre-fix OCR parser bug (dev_task
 * 3274fdf6). The parser fix shipped in commit 9a457d7 — this script
 * applies the new parser retroactively to existing documents.
 *
 * Usage: npx tsx scripts/backfill-passport-data.ts
 * Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *           GOOGLE_SA_KEY, GOOGLE_IMPERSONATE_EMAIL in .env.local.
 *
 * Serial execution — OCR takes ~3–10s per doc. Estimated runtime for
 * 66 contacts: ~5 minutes. Does NOT overwrite existing non-null values.
 */

import { createClient } from "@supabase/supabase-js"
import { resolve } from "path"
import { config } from "dotenv"

config({ path: resolve(__dirname, "../.env.local") })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

interface Target {
  id: string
  full_name: string | null
  passport_number: string | null
  passport_expiry_date: string | null
}

interface PassportDoc {
  drive_file_id: string
  mime_type: string | null
  file_name: string
}

async function findTargets(): Promise<Target[]> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name, passport_number, passport_expiry_date")
    .eq("passport_on_file", true)
    .or("passport_number.is.null,passport_expiry_date.is.null")
  if (error) throw error
  return data as Target[]
}

async function findPassportDoc(contactId: string): Promise<PassportDoc | null> {
  const { data, error } = await supabase
    .from("documents")
    .select("drive_file_id, mime_type, file_name")
    .eq("contact_id", contactId)
    .eq("document_type_name", "Passport")
    .not("drive_file_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data as PassportDoc | null
}

async function main() {
  // Lazy-import OCR + parser so we get the live code paths from lib/.
  const { ocrDriveFile } = await import("../lib/docai")
  const { parsePassportFromOcr } = await import("../lib/passport-processing")

  const targets = await findTargets()
  console.log(`Found ${targets.length} contacts flagged passport_on_file=true with missing fields.`)

  const OCR_SUPPORTED = new Set([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/gif",
    "image/bmp",
    "image/webp",
  ])

  let filled = 0
  let skipped_no_doc = 0
  let skipped_unsupported = 0
  let skipped_no_data = 0
  let errored = 0

  for (let idx = 0; idx < targets.length; idx++) {
    const c = targets[idx]
    const label = `[${idx + 1}/${targets.length}] ${c.full_name ?? c.id}`
    const doc = await findPassportDoc(c.id)
    if (!doc?.drive_file_id) {
      console.log(`SKIP ${label} — no passport document row`)
      skipped_no_doc++
      continue
    }
    const mime = doc.mime_type || "application/pdf"
    if (!OCR_SUPPORTED.has(mime)) {
      console.log(`SKIP ${label} — unsupported mime ${mime}`)
      skipped_unsupported++
      continue
    }

    try {
      const ocr = await ocrDriveFile(doc.drive_file_id)
      if (!ocr.fullText) {
        console.log(`NONE ${label} — OCR returned no text`)
        skipped_no_data++
        continue
      }
      const parsed = parsePassportFromOcr(ocr.fullText)
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (parsed.passportNumber && !c.passport_number) updates.passport_number = parsed.passportNumber
      if (parsed.expiryDate && !c.passport_expiry_date) updates.passport_expiry_date = parsed.expiryDate

      const changedFields = Object.keys(updates).filter(k => k !== "updated_at")
      if (changedFields.length === 0) {
        console.log(`NONE ${label} — OCR ran but MRZ / visual patterns didn't match`)
        skipped_no_data++
        continue
      }

      // eslint-disable-next-line no-restricted-syntax -- one-off backfill script; bypasses reconcileTier since portal_tier isn't touched
      const { error: upErr } = await supabase
        .from("contacts")
        .update(updates)
        .eq("id", c.id)
      if (upErr) {
        console.log(`ERR  ${label} — ${upErr.message}`)
        errored++
        continue
      }
      console.log(`OK   ${label} — ${changedFields.join(", ")}`)
      filled++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`ERR  ${label} — ${msg}`)
      errored++
    }
  }

  console.log("\n=== Batch summary ===")
  console.log(`Total targeted:        ${targets.length}`)
  console.log(`Filled:                ${filled}`)
  console.log(`No passport doc row:   ${skipped_no_doc}`)
  console.log(`Unsupported mime:      ${skipped_unsupported}`)
  console.log(`OCR returned nothing:  ${skipped_no_data}`)
  console.log(`Errored:               ${errored}`)
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
