/* eslint-disable no-console -- CLI validation report; console output is the deliverable */
/**
 * VALIDATION HARNESS (read-only) — AI bank-statement extraction vs REAL statements.
 *
 * Downloads the actual client statement files from Google Drive (read-only),
 * runs the new parseBankStatement (Wise fast path + AI fallback + zip), and
 * prints per-file: transaction count, income/expense totals, currency, and the
 * reconciliation verdict. NO database writes, NO Drive writes, NO CRM changes.
 *
 * Run:
 *   npx tsx --env-file=/Users/10225office/Developer/td-operations/.env.local \
 *           --env-file=/tmp/td-sandbox-env-pull.env \
 *           scripts/validate-ai-statement-extraction.ts
 */

// Env layering: exported shell vars win (ANTHROPIC_API_KEY), then the pulled
// sandbox Vercel env (GOOGLE_SA_KEY — empty in this machine's .env.local),
// then .env.local for the rest. dotenv never overrides already-set vars.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("dotenv").config({ path: "/tmp/td-sandbox-env-pull.env" })
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("dotenv").config({ path: "/Users/10225office/Developer/td-operations/.env.local" })

import { downloadFileBinary } from "../lib/google-drive"
import { parseBankStatement } from "../lib/bank-statement-parser"

const FILES: Array<{ client: string; label: string; fileId: string }> = [
  { client: "MPG Performance LLC", label: "Relay_statement_2025.pdf", fileId: "14kx4JbeELpXJHOvNRQIQM5h7-Wu4IIix" },
  { client: "MPG Performance LLC", label: "Wise_statement_2025.pdf", fileId: "10hAvik6l82d33c8hiSPJmJhvqznuIIL9" },
  { client: "MPG Performance LLC", label: "Mercury_statement_2025.pdf", fileId: "1bhyq-VjPEY2ie-I3px11RAoDw6ewgyYq" },
  { client: "Nexo Agency LLC", label: "Bank_statement_2025.pdf", fileId: "1-H-WaHNoOXi-xuq0BUubaKkKNmgOSbOZ" },
  { client: "Dynamiq SR LLC", label: "WISE-2025-STATEMENTS.csv (fast-path regression)", fileId: "1AVPqdvWaF2TN-OeLDL12qM3Oa-3LFEF4" },
]

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing")
  if (!process.env.GOOGLE_SA_KEY) throw new Error("GOOGLE_SA_KEY missing")

  let pass = 0
  let review = 0
  for (const f of FILES) {
    process.stdout.write(`\n━━━ ${f.client} — ${f.label} ━━━\n`)
    try {
      const { buffer, mimeType, fileName } = await downloadFileBinary(f.fileId)
      const t0 = Date.now()
      const r = await parseBankStatement(buffer, fileName, mimeType)
      const secs = ((Date.now() - t0) / 1000).toFixed(1)

      const income = r.transactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0)
      const outflow = r.transactions.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0)
      const dates = r.transactions.map(t => t.transaction_date).sort()

      console.log(`method=${r.extraction_method} bank=${r.bank_name} currency=${r.currency} (${secs}s)`)
      console.log(`transactions=${r.transactions.length} inflows=${income.toFixed(2)} outflows=${outflow.toFixed(2)}`)
      if (dates.length) console.log(`period: ${dates[0]} → ${dates[dates.length - 1]}`)
      if (r.reconciliation) {
        console.log(`reconciliation: ${String(r.reconciliation.reconciled)} — ${r.reconciliation.note}`)
        if (r.reconciliation.reconciled === false) review++
      }
      if (r.errors.length) console.log(`errors: ${r.errors.join(" | ")}`)
      if (r.transactions.length > 0) {
        console.log(`first: ${JSON.stringify(r.transactions[0])}`)
        console.log(`last:  ${JSON.stringify(r.transactions[r.transactions.length - 1])}`)
        pass++
      }
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(`\n══════ ${pass}/${FILES.length} extracted transactions; ${review} flagged for human review ══════`)
}

main().catch(e => { console.error(e); process.exit(1) })
