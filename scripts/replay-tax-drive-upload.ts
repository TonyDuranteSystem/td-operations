/* eslint-disable no-console */
/**
 * One-time recovery script: replay Drive upload for a specific tax submission.
 *
 * Usage:
 *   VERCEL=1 npx tsx scripts/replay-tax-drive-upload.ts
 *
 * Requires production env vars to be loaded (NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_KEY, etc.)
 * The VERCEL=1 env var bypasses the non-Vercel production guard in
 * lib/supabase-admin.ts so this script can run locally against prod.
 */

// Load production credentials from .env.prod.local BEFORE importing supabaseAdmin.
// supabaseAdmin uses a lazy Proxy: env vars are read only on first property access,
// so dotenv.config() here runs before any DB call is made, not before the import.
import dotenv from "dotenv"
dotenv.config({ path: ".env.prod.local", override: true })
// The URL is intentionally blank in .env.prod.local (local guard would block it),
// so we set it explicitly here now that VERCEL=1 bypasses the guard.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ydzipybqeebtpcvsbtvs.supabase.co"
process.env.VERCEL = "1"  // bypass lib/supabase-admin.ts non-Vercel production guard

import { supabaseAdmin } from "@/lib/supabase-admin"

const SUBMISSION_ID = "6a5503ac-80dc-4893-b5d2-1d1426f61f43"

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
  console.log("[replay] Supabase URL:", supabaseUrl.substring(0, 50) + "...")

  if (!supabaseUrl.includes("ydzipybqeebtpcvsbtvs")) {
    throw new Error(
      `ERROR: Expected PRODUCTION Supabase (ydzipybqeebtpcvsbtvs) but got: ${supabaseUrl}\n` +
      "Load the .env.production.temp file before running this script."
    )
  }

  // ── 1. Look up the submission ──────────────────────────────────────────────
  console.log("\n[1] Looking up submission", SUBMISSION_ID)
  const { data: sub, error: subErr } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("id, token, account_id, contact_id, submitted_data, upload_paths, tax_year, created_at, entity_type")
    .eq("id", SUBMISSION_ID)
    .single()

  if (subErr || !sub) {
    throw new Error(`Submission not found: ${subErr?.message}`)
  }

  const uploadPaths = Array.isArray(sub.upload_paths) ? (sub.upload_paths as string[]) : []
  console.log("  token       :", sub.token)
  console.log("  account_id  :", sub.account_id)
  console.log("  contact_id  :", sub.contact_id)
  console.log("  tax_year    :", sub.tax_year)
  console.log("  entity_type :", sub.entity_type)
  console.log("  created_at  :", sub.created_at)
  console.log("  upload_paths:", uploadPaths.length, "files")
  uploadPaths.forEach((p, i) => console.log(`    [${i}]`, p))

  if (!sub.account_id) {
    throw new Error("Submission has no account_id — cannot determine Drive folder")
  }

  // ── 2. Look up the account's Drive folder ────────────────────────────────
  console.log("\n[2] Looking up account", sub.account_id)
  const { data: acc, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("drive_folder_id, company_name")
    .eq("id", sub.account_id)
    .single()

  if (accErr || !acc) {
    throw new Error(`Account not found: ${accErr?.message}`)
  }

  console.log("  company_name   :", acc.company_name)
  console.log("  drive_folder_id:", acc.drive_folder_id)

  if (!acc.drive_folder_id) {
    throw new Error("Account has no drive_folder_id — cannot copy files to Drive")
  }

  // ── 3. Call saveFormToDrive with the corrected bucket ────────────────────
  console.log("\n[3] Calling saveFormToDrive...")
  console.log("  form_type : tax_return")
  console.log("  bucket    : onboarding-uploads  (portal wizard bucket — the fix)")
  console.log("  year      :", sub.tax_year || new Date().getFullYear() - 1)

  const { saveFormToDrive } = await import("@/lib/form-to-drive")

  const result = await saveFormToDrive(
    "tax_return",
    (sub.submitted_data || {}) as Record<string, unknown>,
    uploadPaths,
    acc.drive_folder_id,
    {
      token: sub.token,
      submittedAt: sub.created_at,
      companyName: acc.company_name || "Sor Solitude Consulting LLC",
      year: sub.tax_year || new Date().getFullYear() - 1,
    },
    // CRITICAL: files were uploaded to onboarding-uploads (portal wizard bucket),
    // NOT the tax-form-uploads default. This was the bug being fixed.
    { bucket: "onboarding-uploads" },
  )

  // ── 4. Report results ────────────────────────────────────────────────────
  console.log("\n=== RESULT ===")
  console.log("Summary PDF drive_file_id :", result.summaryFileId ?? "(none)")
  console.log("Files copied              :", result.copied.length)
  result.copied.forEach(f => console.log("  ✅", f))
  console.log("Files failed              :", result.failed.length)
  result.failed.forEach(f => console.log("  ❌", f))
  console.log("Errors                    :", result.errors.length)
  result.errors.forEach(e => console.log("  ⚠️ ", e))

  if (result.errors.length > 0 || result.failed.length > 0) {
    console.error("\n⚠️  Some files failed. Check the output above.")
    process.exit(1)
  } else {
    console.log(`\n✅ Success: ${result.copied.length} file(s) + 1 summary PDF saved to Drive.`)
  }
}

main().catch(err => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err)
  process.exit(1)
})
