/* eslint-disable no-console -- CLI staging script, console output is the point */
/**
 * Stage the locally-regenerated Valerio Di Santo W-7/1040-NR/Schedule OI PDFs
 * in SANDBOX Supabase Storage (onboarding-uploads bucket) so they're reachable
 * via public URL. Once staged, the URLs are printed for the caller to feed
 * into the production MCP drive_upload_file tool (source=url).
 *
 * Why this two-step dance: local sandbox env has no Google SA key (intentional
 * — Drive ops run on the production deployment), so we can't upload to Drive
 * from this machine directly. But we CAN upload to sandbox Supabase storage
 * (creds are in .env.local), and the resulting URL is public so the production
 * MCP can fetch from it.
 *
 * Run with: npx tsx --env-file=.env.local scripts/upload-valerio-corrected-pdfs.ts
 */

import fs from "fs"
import path from "path"
import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

const BUCKET = "assets"
const STAGE_DIR = `temp-valerio-rerun-${Date.now()}`
const PDF_DIR = path.join(process.cwd(), "tmp", "pdf-debug", "valerio-rerun")
const FILES = [
  "W-7_Valerio_Di_Santo.pdf",
  "1040-NR_Valerio_Di_Santo.pdf",
  "Schedule_OI_Valerio_Di_Santo.pdf",
]

async function main() {
  const urls: { filename: string; url: string; storagePath: string }[] = []
  for (const filename of FILES) {
    const filePath = path.join(PDF_DIR, filename)
    const buf = fs.readFileSync(filePath)
    const storagePath = `${STAGE_DIR}/${filename}`
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buf, { contentType: "application/pdf", upsert: true })
    if (error) {
      console.error(`Upload failed: ${filename}`, error)
      process.exit(1)
    }
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath)
    urls.push({ filename, url: pub.publicUrl, storagePath })
    console.log(`Staged: ${filename}`)
  }
  console.log("\n--- Drive-upload URLs ---")
  for (const u of urls) {
    console.log(`${u.filename}\n  ${u.url}\n`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
