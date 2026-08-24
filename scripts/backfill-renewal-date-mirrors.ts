/* eslint-disable no-console -- CLI backfill script reports progress via stdout. */
/**
 * One-time correction for accounts whose client-facing renewal record
 * (`deadlines`) disagrees with, or is missing relative to, the account's own
 * `ra_renewal_date` / `annual_report_due_date` — the historical bug fixed by
 * dev job 8bd0e51a (4+3 write paths that bypassed the mirror before
 * setAccountRenewalDate existed).
 *
 * Idempotent and safe to re-run: for each affected account+column, it calls
 * the SAME setAccountRenewalDate() every live writer now uses, passing the
 * account's OWN current value — this either inserts the missing client-facing
 * record or corrects a disagreeing one, exactly as if staff had just
 * re-saved that date. Runs STRICTLY SEQUENTIALLY (no parallelism) to
 * minimize (not eliminate — no DB unique constraint exists) the race window
 * with a live concurrent edit.
 *
 * An account with more than one open (non-terminal) deadlines row for the
 * same obligation is NEVER auto-corrected — setAccountRenewalDate refuses to
 * guess which row is right. Those accounts are collected into a separate
 * "needs manual review" list and printed at the end for Antonio, never
 * silently skipped.
 *
 * Default is DRY RUN — prints what it would do without writing anything.
 * Apply for real:
 *   CONFIRM_PRODUCTION_BACKFILL=1 npx tsx scripts/backfill-renewal-date-mirrors.ts --apply
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL from .env.local to determine the target —
 * prints which environment it's about to touch before doing anything, and
 * refuses to --apply against production without the confirmation env var.
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { setAccountRenewalDate, type RenewalDateColumn } from "@/lib/operations/renewal-dates"

const PROD_REF = "ydzipybqeebtpcvsbtvs"
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
const isProd = url.includes(PROD_REF)
const APPLY = process.argv.includes("--apply")

console.log(`Target: ${url || "(unset)"} — ${isProd ? "PRODUCTION" : "non-production"}`)
console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`)

if (APPLY && isProd && process.env.CONFIRM_PRODUCTION_BACKFILL !== "1") {
  console.error("")
  console.error("Refusing to apply against PRODUCTION without CONFIRM_PRODUCTION_BACKFILL=1.")
  console.error("Re-run as: CONFIRM_PRODUCTION_BACKFILL=1 npx tsx scripts/backfill-renewal-date-mirrors.ts --apply")
  process.exit(1)
}

const RENEWAL_COLUMNS: Array<{ column: RenewalDateColumn; deadlineType: "RA Renewal" | "Annual Report" }> = [
  { column: "ra_renewal_date", deadlineType: "RA Renewal" },
  { column: "annual_report_due_date", deadlineType: "Annual Report" },
]
const TERMINAL_STATUSES = new Set(["Completed", "Filed", "Cancelled"])

interface Finding {
  accountId: string
  companyName: string
  column: RenewalDateColumn
  accountValue: string
  reason: "missing" | "disagreeing" | "duplicate"
  duplicateRowIds?: string[]
}

async function findAffected(): Promise<Finding[]> {
  const findings: Finding[] = []

  const { data: accounts, error } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, ra_renewal_date, annual_report_due_date")
    .eq("status", "Active")
    .eq("account_type", "Client")
    .or("is_test.is.null,is_test.eq.false")
    .or("ra_renewal_date.not.is.null,annual_report_due_date.not.is.null")

  if (error) throw new Error(`account scan failed: ${error.message}`)

  for (const acct of accounts ?? []) {
    for (const { column, deadlineType } of RENEWAL_COLUMNS) {
      const value = (acct as Record<string, unknown>)[column] as string | null
      if (!value) continue

      const { data: rows } = await supabaseAdmin
        .from("deadlines")
        .select("id, due_date, status")
        .eq("account_id", acct.id)
        .eq("deadline_type", deadlineType)

      const open = (rows ?? []).filter((r) => r.status == null || !TERMINAL_STATUSES.has(r.status))

      if (open.length > 1) {
        findings.push({
          accountId: acct.id,
          companyName: acct.company_name,
          column,
          accountValue: value,
          reason: "duplicate",
          duplicateRowIds: open.map((r) => r.id),
        })
      } else if (open.length === 0) {
        findings.push({ accountId: acct.id, companyName: acct.company_name, column, accountValue: value, reason: "missing" })
      } else if (open[0].due_date !== value) {
        findings.push({ accountId: acct.id, companyName: acct.company_name, column, accountValue: value, reason: "disagreeing" })
      }
    }
  }

  return findings
}

async function main() {
  console.log("\nScanning for accounts whose renewal date disagrees with the client-facing copy...\n")
  const findings = await findAffected()

  const fixable = findings.filter((f) => f.reason !== "duplicate")
  const duplicates = findings.filter((f) => f.reason === "duplicate")

  console.log(`Found ${findings.length} affected (account, column) pairs:`)
  console.log(`  ${findings.filter((f) => f.reason === "missing").length} missing the client-facing record entirely`)
  console.log(`  ${findings.filter((f) => f.reason === "disagreeing").length} with a disagreeing date`)
  console.log(`  ${duplicates.length} with more than one open record — CANNOT be auto-corrected\n`)

  if (!APPLY) {
    console.log("DRY RUN — no writes performed. Sample of what would be corrected:")
    for (const f of fixable.slice(0, 20)) {
      console.log(`  ${f.companyName} (${f.accountId}): ${f.column} → ${f.accountValue} [${f.reason}]`)
    }
    if (fixable.length > 20) console.log(`  ... and ${fixable.length - 20} more`)
  } else {
    console.log(`Applying corrections sequentially (${fixable.length} writes)...\n`)
    let corrected = 0
    let failed = 0
    for (const f of fixable) {
      const result = await setAccountRenewalDate(f.accountId, f.column, f.accountValue, {
        actor: "backfill:8bd0e51a",
        summary: `One-time renewal-date mirror backfill (${f.reason})`,
        details: { reason: f.reason, column: f.column, value: f.accountValue },
      })
      if (result.success) {
        corrected++
        console.log(`  ✅ ${f.companyName}: ${f.column} → ${f.accountValue}`)
      } else {
        failed++
        console.log(`  ❌ ${f.companyName}: ${f.column} — ${result.error}`)
      }
    }
    console.log(`\nDone: ${corrected} corrected, ${failed} failed.`)
  }

  if (duplicates.length > 0) {
    console.log(`\n⚠️  ${duplicates.length} accounts need MANUAL review (more than one open record — never auto-guessed):`)
    for (const f of duplicates) {
      console.log(`  ${f.companyName} (${f.accountId}): ${f.column}, rows ${f.duplicateRowIds?.join(", ")}`)
    }
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
