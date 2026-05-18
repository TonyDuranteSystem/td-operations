/**
 * Catalog-validity deploy gate.
 *
 * Reads every active `task_workflows` row from the configured Supabase
 * project (sandbox by default) and runs `validateWorkflowCatalog`. Exits 1
 * on any issue so it can be wired into the rollout playbook as a hard gate.
 *
 * Usage:
 *   npx tsx scripts/check-catalog-validity.ts
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local (via
 * dotenv) — same convention as scripts/apply-migration.js.
 *
 * Pre-Slice-14 sanity gate: run this before promoting the workflow
 * migrations to production, and again after, to verify nothing slipped.
 */

import { createClient } from "@supabase/supabase-js"
import { config } from "dotenv"
import { validateWorkflowCatalog, type CatalogWorkflowRow } from "@/lib/tasks/catalog-validity"
import { getRegisteredAttachmentTemplateNames } from "@/components/tasks/attachment-templates"

config({ path: ".env.local" })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  // eslint-disable-next-line no-console -- CLI script: console output is the UI
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
  process.exit(2)
}

async function main(): Promise<void> {
  const sb = createClient(SUPABASE_URL!, SUPABASE_KEY!, { auth: { persistSession: false } })
  const { data, error } = await sb
    .from("catalog_entries")
    .select("slug, status, metadata")
    .eq("catalog_id", "task_workflows")
    .eq("status", "active")
  if (error) {
    // eslint-disable-next-line no-console -- CLI script: console output is the UI
    console.error("query failed:", error.message)
    process.exit(2)
  }

  const rows = (data ?? []) as CatalogWorkflowRow[]
  const report = validateWorkflowCatalog(rows, {
    attachmentTemplateNames: getRegisteredAttachmentTemplateNames(),
  })

  // eslint-disable-next-line no-console -- CLI script: console output is the UI
  console.log(`scanned: ${report.scanned}, passed: ${report.passed}, issues: ${report.issues.length}`)
  if (report.issues.length > 0) {
    for (const issue of report.issues) {
      // eslint-disable-next-line no-console -- CLI script: console output is the UI
      console.error(`  [${issue.kind}] ${issue.slug}: ${issue.detail}`)
    }
    process.exit(1)
  }
  // eslint-disable-next-line no-console -- CLI script: console output is the UI
  console.log("✅ catalog clean")
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- CLI script: console output is the UI
  console.error("fatal:", err)
  process.exit(2)
})
