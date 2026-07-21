/* eslint-disable no-console -- CLI gate: reports its findings on stdout. */
/**
 * CODE ↔ DATABASE CONTRACT CHECK — the CLI gate.
 *
 * Asserts that every value the code can write into a CHECK-constrained column is a value the
 * database will actually accept. The comparison itself lives in lib/db-contract.ts; this file
 * is only the transport + the report.
 *
 * WHY THE DEFAULT SOURCE IS A FILE, NOT A DATABASE:
 *
 * The gate has to check the code against PRODUCTION's rules — production is the database that
 * rejects writes, and sandbox has historically been more permissive (which is exactly how the
 * review queue died: a 32/32 green harness against a database with no constraints at all).
 *
 * But reading production live, at push time, means a production database password in CI. That
 * is a new credential and a new exposure surface, created so a workflow can read a list of
 * allowed strings. Bad trade — and a gate whose credential nobody ever sets is not a gate, it
 * is a green checkmark that enforces nothing (we have one of those already; it is being
 * deleted in this same change).
 *
 * So production's rules are COMMITTED (db/constraints.prod.json, checksum-verified against the
 * database that produced them), and this gate blocks against the file. No credential, runs on
 * every machine, every push, offline.
 *
 * The obvious hole — "a snapshot rots" — is closed by the in-app monitor
 * (lib/db-contract-monitor.ts), which re-reads LIVE production daily and raises a dev-board job
 * the moment the file and reality disagree. The snapshot gates the code; the monitor keeps the
 * snapshot honest.
 *
 * Usage:
 *   npx tsx scripts/check-db-constraints.ts                 # vs the committed prod snapshot (default)
 *   npx tsx scripts/check-db-constraints.ts --source=db     # vs a live DB (SUPABASE_DB_URL, e.g. sandbox)
 *   npx tsx scripts/check-db-constraints.ts --source=supabase   # vs a live DB via service-role RPC (CI)
 *
 * With --source=db|supabase it ALSO reports drift against the committed snapshot, which is how
 * CI notices that sandbox and production have diverged.
 *
 * Exits non-zero on any violation.
 */

import { config } from "dotenv"
import { createClient } from "@supabase/supabase-js"
import {
  checkDbContract,
  diffAgainstSnapshot,
  CONSTRAINT_QUERY,
  rowsToDefs,
  CONSTRAINT_CONTRACTS,
  type ConstraintDefs,
} from "../lib/db-contract"
import { prodConstraints, prodSnapshotMeta, verifySnapshotIntegrity } from "../lib/db-contract-snapshot"
import { readLiveConstraints } from "../lib/db-contract-read"

config({ path: ".env.local" })

type Source = "snapshot" | "db" | "supabase"
const sourceArg = process.argv.find(a => a.startsWith("--source="))
const SOURCE: Source = (sourceArg?.split("=")[1] as Source) || "snapshot"

async function readFromPostgres(): Promise<ConstraintDefs> {
  const url = process.env.SUPABASE_DB_URL
  if (!url) throw new Error("--source=db needs SUPABASE_DB_URL (a Postgres connection string).")

  // Imported lazily: `pg` is a devDependency and the default (snapshot) path must not need it.
  const { Client } = await import("pg")
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await client.connect()
  const { rows } = await client.query<{ name: string; def: string }>(CONSTRAINT_QUERY)
  await client.end()
  console.log(`Live database: ${url.replace(/:[^:@]+@/, ":****@")}\n`)
  return rowsToDefs(rows)
}

async function readFromSupabase(): Promise<ConstraintDefs> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error("--source=supabase needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
  }
  console.log(`Live database: ${url}\n`)
  return readLiveConstraints(createClient(url, key))
}

async function main() {
  // ── The snapshot must be honest before anything is compared to it ────────────────────
  const integrity = verifySnapshotIntegrity()
  if (!integrity.ok) {
    console.log("FAIL  The committed production snapshot is not internally consistent.")
    console.log(`      ${integrity.reason}`)
    process.exit(1)
  }

  const meta = prodSnapshotMeta()
  let defs: ConstraintDefs
  let label: string

  if (SOURCE === "snapshot") {
    defs = prodConstraints()
    label = `the committed PRODUCTION snapshot (${meta.count} constraints, taken ${meta.generatedAt})`
  } else {
    defs = SOURCE === "db" ? await readFromPostgres() : await readFromSupabase()
    label = `a LIVE database (${Object.keys(defs).length} constraints)`
  }

  console.log(`Checking the code against ${label}.\n`)

  const { violations, warnings, passed } = checkDbContract(defs)

  for (const name of passed) console.log(`PASS  ${name} — code and database agree.`)
  for (const w of warnings) console.log(`WARN  ${w.message}`)
  for (const v of violations) console.log(`FAIL  ${v.message}`)

  // ── Drift: does this live database still match the committed production snapshot? ────
  //
  // Only meaningful when we actually read a live database. This is what tells CI that sandbox
  // has drifted from production — the divergence that made a green test suite worthless.
  let driftFailures = 0
  if (SOURCE !== "snapshot") {
    const drift = diffAgainstSnapshot(defs, prodConstraints())
    if (drift.length > 0) {
      console.log()
      console.log(`NOTE  This database differs from the committed production snapshot in ${drift.length} place(s).`)
      console.log(`      Expected for sandbox (it carries dev-only tables); NOT expected for production.`)
      for (const d of drift.slice(0, 15)) console.log(`      - ${d.message}`)
      if (drift.length > 15) console.log(`      … and ${drift.length - 15} more.`)

      // A drift in a REGISTERED contract is not informational — it is the trap itself: the
      // environment we test against no longer enforces what production enforces.
      // DERIVED from CONSTRAINT_CONTRACTS, never hand-listed. This used to be a
      // second hardcoded copy of the registered names, so registering a new
      // contract left this half of the check silently unenforced — a duplicated
      // list that rots is how the gate loses its teeth without anyone noticing.
      const registeredNames = new Set<string>(CONSTRAINT_CONTRACTS.map(c => c.constraint))
      const registeredDrift = drift.filter(d => registeredNames.has(d.constraint))
      if (registeredDrift.length > 0) {
        console.log()
        for (const d of registeredDrift) {
          console.log(`FAIL  ${d.constraint} — this database does NOT enforce what production enforces.`)
          console.log(`      Every test that passes here proves nothing about production. That is the bug.`)
        }
        driftFailures += registeredDrift.length
      }
    }
  }

  console.log()
  const total = violations.length + driftFailures
  if (total > 0) {
    console.log(`RESULT: ${total} violation(s). The code and the database do not agree.`)
    process.exit(1)
  }
  console.log("RESULT: code and database agree.")
}

main().catch(err => {
  console.error("Contract check crashed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
