/* eslint-disable no-console -- operator script */
/**
 * Stop-Drive S1a backfill: file client uploads that are parked in the older bucket (documents rows whose pointer is
 * `storage:flow-uploads/...`) into the CRM storage, for companies/people that are ALREADY in the storage, and re-point each
 * documents row at the store file (one record). Safe to re-run (idempotent). Never deletes the original bucket object.
 *
 *   DRY RUN (default, writes nothing):   npx tsx scripts/crm-store/adopt-storage-pointers.ts
 *   APPLY on the sandbox:                npx tsx scripts/crm-store/adopt-storage-pointers.ts --apply
 *   APPLY on PRODUCTION (only after Antonio's explicit go):
 *                                         ALLOW_PRODUCTION_ADOPT=1 npx tsx scripts/crm-store/adopt-storage-pointers.ts --apply
 *
 * Needs the usual .env.local (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) of the environment you mean to touch.
 */
import dotenv from "dotenv"
dotenv.config({ path: process.env.QA_ENV_FILE || ".env.local" })

const PRODUCTION_REF = "ydzipybqeebtpcvsbtvs"

async function main() {
  const apply = process.argv.includes("--apply")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  const isProduction = url.includes(PRODUCTION_REF)
  console.log(`Environment: ${isProduction ? "PRODUCTION" : url.includes("xjcxlmlpeywtwkhstjlw") ? "sandbox" : url}  ·  mode: ${apply ? "APPLY" : "dry run"}`)
  if (apply && isProduction && process.env.ALLOW_PRODUCTION_ADOPT !== "1") {
    console.error("Refusing: applying on production needs ALLOW_PRODUCTION_ADOPT=1 and Antonio's explicit go.")
    process.exit(1)
  }

  const { adoptionCandidates, adoptStoragePointerRow } = await import("../../lib/crm-store/adopt-storage-pointer")
  const rows = await adoptionCandidates()
  console.log(`${rows.length} document record(s) still point into the older flow-uploads bucket.\n`)

  const tally: Record<string, number> = {}
  for (const r of rows) {
    if (!apply) {
      // dry run: report what would be tried, without writing — the real decision is made by adoptStoragePointerRow on apply
      console.log(`  would try  ${r.id}  ${r.file_name}  (account ${r.account_id ?? "-"}, person ${r.contact_id ?? "-"}, stage ${r.flow_stage ?? "-"})`)
      continue
    }
    const res = await adoptStoragePointerRow(r)
    const key = res.status === "skipped" || res.status === "failed" ? `${res.status}: ${res.reason}` : res.status
    tally[key] = (tally[key] ?? 0) + 1
    console.log(`  ${res.status.padEnd(8)} ${r.id}  ${r.file_name}${"reason" in res ? `  — ${res.reason}` : ""}`)
  }
  if (apply) {
    console.log("\nSummary:")
    for (const [k, v] of Object.entries(tally)) console.log(`  ${v}  ${k}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
