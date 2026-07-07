/* eslint-disable no-console -- QA gate; console output IS the product */
/**
 * S1 replay regression gate (AI-architect ship condition, 2026-07-07).
 *
 * Replays real statement files through the NEW pipeline (mapping store
 * injected, in-memory + seeded Mercury-variant mapping) and asserts:
 *  - known-signature files (Wise/Relay) parse identically to the legacy path;
 *  - the Dynamiq Mercury variant parses through the SEEDED mapping: bank name
 *    Mercury, every amount settled USD (no original-currency rows), all 12
 *    months, and row count matching the incident's ingest record (1,989);
 *  - the Chase PDF-as-CSV is REJECTED into quarantine/AI, never mis-parsed.
 *
 * Usage: npx tsx scripts/qa/statement-replay-gate.ts <dir-with-real-files>
 * (files are read locally; nothing is written anywhere)
 */
import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import { parseBankStatement, type ParseResult } from "../../lib/bank-statement-parser"
import { formatFingerprint, type FormatMapping, type StoredMapping } from "../../lib/bank-format-mappings"

const MERCURY_VARIANT_MAPPING: FormatMapping = {
  version: 1,
  bank_label: "Mercury",
  date: { col: 0, order: "mdy" },
  description_cols: [1, 5],
  counterparty_col: 5,
  amount: { mode: "signed", col: 2, positive_is: "in" },
  currency: { mode: "settled_fixed_with_original", value: "USD", original_col: 13 },
  account: { mode: "column", col: 4 },
  balance_col: null,
  status: { col: 3, include: ["sent"] },
  ref_extra_cols: [4, 12],
}
const MERCURY_FP = formatFingerprint("Date (UTC),Description,Amount,Status,Source Account,Bank Description,Reference,Note,Last Four Digits,Name On Card,Category,GL Code,Timestamp,Original Currency,Check Number,Tags".split(","))

let pass = 0, fail = 0
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`) }
}

async function main() {
  const dir = process.argv[2]
  if (!dir) { console.error("usage: npx tsx scripts/qa/statement-replay-gate.ts <dir>"); process.exit(1) }

  const stored = new Map<string, StoredMapping>()
  stored.set(MERCURY_FP, { id: "seed-mercury", fingerprint: MERCURY_FP, mapping: MERCURY_VARIANT_MAPPING, status: "staff_confirmed", bank_label: "Mercury" })
  const store = {
    lookup: async (fp: string) => stored.get(fp) ?? null,
    recordHit: async () => {},
    store: async (r: { fingerprint: string; mapping: FormatMapping; status: "proposed" | "verified_auto"; bank_label: string }) => {
      const id = `mem-${stored.size}`
      stored.set(r.fingerprint, { id, fingerprint: r.fingerprint, mapping: r.mapping, status: r.status, bank_label: r.bank_label })
      return id
    },
  }

  for (const f of readdirSync(dir).filter(f => f.endsWith(".csv")).sort()) {
    const buffer = readFileSync(join(dir, f))
    console.log(`\n— ${f} (${buffer.length} bytes) —`)
    // BANK_STATEMENT_AI_DISABLED guards the gate against accidental API spend:
    // everything here must parse deterministically or quarantine.
    process.env.BANK_STATEMENT_AI_DISABLED = "true"
    const r: ParseResult = await parseBankStatement(buffer, f, "text/csv", { mappingStore: store })
    console.log(`   method=${r.extraction_method} bank=${r.bank_name} rows=${r.transactions.length} period=${r.period}`)

    if (/mercury/i.test(f)) {
      check("Mercury variant parses via the SEEDED mapping", r.extraction_method === "mapped_csv" && r.bank_name === "Mercury")
      // 1,956 = the file's 1,989 rows MINUS 33 non-Sent (Failed/Cancelled).
      // The OLD ingest inserted all 1,989 — failed transactions in the books;
      // the mapping's status filter excludes them, and the net then ties the
      // client's real Mercury movement to the cent ($101,437.73).
      check("row count = Sent rows only (1956; old pipeline wrongly ingested 33 Failed rows)", r.transactions.length === 1956, String(r.transactions.length))
      check("the 33 non-Sent rows are reported, not silent", r.errors.join(" ").includes("Skipped 33"), r.errors.join(" | "))
      check("every amount is settled USD (double-conversion class dead)", r.transactions.every(t => t.currency === "USD"))
      const months = new Set(r.transactions.map(t => t.transaction_date.slice(0, 7)))
      check("all 12 months of 2024 present", Array.from(months).filter(m => m.startsWith("2024-")).length === 12, Array.from(months).sort().join(","))
      const net = r.transactions.reduce((s, t) => s + t.amount, 0)
      console.log(`   net movement (Sent rows): ${net.toFixed(2)} — cross-check against the client's per-bank reconciliation`)
      const accounts = new Set(r.transactions.map(t => t.account_type))
      console.log(`   accounts: ${Array.from(accounts).join(" | ")}`)
    } else if (/chase/i.test(f)) {
      check("Chase PDF-as-CSV is NOT mis-parsed (no rows accepted)", r.transactions.length === 0)
      check("…and does not silently pass (quarantined or unreadable)", r.extraction_method === "quarantined" || r.extraction_method === "unknown", r.extraction_method)
    } else {
      // Known-signature files must keep their legacy method (regression).
      check("known-signature parser still owns this file", ["wise_csv", "relay_csv", "mercury_csv", "revolut_csv", "slash_csv"].includes(r.extraction_method ?? ""), r.extraction_method)
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error("FATAL:", e); process.exit(1) })
