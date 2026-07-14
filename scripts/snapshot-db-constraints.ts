/* eslint-disable no-console -- CLI tool: reports on stdout. */
/**
 * REGENERATE db/constraints.prod.json FROM PRODUCTION.
 *
 * The committed snapshot is what the pre-push hook and CI gate the code against. When
 * production's CHECK constraints legitimately change (a migration adds an allowed value), this
 * is how the file is brought back in step — and it is the ONLY honest way to change it.
 *
 * ⚠️ IT REFUSES TO RUN AGAINST ANY DATABASE BUT PRODUCTION.
 *
 * Not paranoia — the failure it prevents is the one that started all this. If someone
 * regenerates this file from sandbox, the gate ends up comparing the code against a database
 * that is *more permissive than production*, and it goes green while production silently
 * rejects every write. That is precisely the state we spent a day discovering. A snapshot taken
 * from the wrong database is worse than no snapshot: it looks like protection.
 *
 * Usage (needs .env.prod.local — production credentials, never committed):
 *   npm run snapshot:constraints
 *
 * After running: commit the file. `npm run check:db-contract` will verify its checksum.
 */

import { config } from "dotenv"
import { writeFileSync, readFileSync } from "node:fs"
import { createClient } from "@supabase/supabase-js"
import { CONSTRAINT_QUERY, rowsToDefs, checksumDefs, type ConstraintDefs } from "../lib/db-contract"
import { readLiveConstraints } from "../lib/db-contract-read"

config({ path: ".env.prod.local" })

/** The production Supabase project. Hardcoded on purpose: this is the assertion, not a setting. */
const PRODUCTION_REF = "ydzipybqeebtpcvsbtvs"
const SNAPSHOT_PATH = "db/constraints.prod.json"

const ALLOW_NON_PROD = process.argv.includes("--i-know-this-is-not-production")

function assertProduction(target: string) {
  if (target.includes(PRODUCTION_REF)) return

  if (ALLOW_NON_PROD) {
    console.warn("⚠️  Writing a snapshot from a NON-PRODUCTION database because you asked for it.")
    console.warn("   Do not commit the result. A gate built on a sandbox snapshot enforces sandbox's")
    console.warn("   rules, not production's — which is the exact hole this file exists to close.")
    return
  }

  console.error("REFUSED — this is not production.")
  console.error("")
  console.error(`  Target      : ${target.replace(/:[^:@]+@/, ":****@")}`)
  console.error(`  Expected ref: ${PRODUCTION_REF}`)
  console.error("")
  console.error("db/constraints.prod.json is what pre-push and CI gate the code against. Regenerating")
  console.error("it from sandbox would gate the code against a database more permissive than the one")
  console.error("that actually rejects writes — the gate would go green while production rejected")
  console.error("every write. That already happened once; it cost months of a dead review queue.")
  console.error("")
  console.error("Point .env.prod.local at production, or pass --i-know-this-is-not-production (and")
  console.error("do not commit the result).")
  process.exit(1)
}

async function readConstraints(): Promise<ConstraintDefs> {
  const dbUrl = process.env.SUPABASE_DB_URL
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (dbUrl) {
    assertProduction(dbUrl)
    const { Client } = await import("pg")
    const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    await client.connect()
    const { rows } = await client.query<{ name: string; def: string }>(CONSTRAINT_QUERY)
    await client.end()
    return rowsToDefs(rows)
  }

  if (supaUrl && supaKey) {
    assertProduction(supaUrl)
    return readLiveConstraints(createClient(supaUrl, supaKey))
  }

  console.error("No production credentials found in .env.prod.local.")
  console.error("Need either SUPABASE_DB_URL, or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.")
  process.exit(1)
}

async function main() {
  const constraints = await readConstraints()
  const names = Object.keys(constraints).sort()
  const sorted: ConstraintDefs = {}
  for (const n of names) sorted[n] = constraints[n]

  const checksum = checksumDefs(sorted)

  // Keep the existing _readme — it is the explanation of why the file exists, and regenerating
  // the snapshot is not a reason to throw the reasoning away.
  const existing = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"))

  const out = {
    _readme: existing._readme,
    generated_from: `production (Supabase ref ${PRODUCTION_REF})`,
    generated_at: new Date().toISOString().slice(0, 10),
    constraint_count: names.length,
    checksum_md5: checksum,
    constraints: sorted,
  }

  writeFileSync(SNAPSHOT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8")

  console.log(`Wrote ${SNAPSHOT_PATH}`)
  console.log(`  constraints : ${names.length}`)
  console.log(`  checksum    : ${checksum}`)
  console.log("")
  console.log("Verify it against the database that produced it:")
  console.log("  SELECT md5(string_agg(conname || '|' || pg_get_constraintdef(oid), E'\\n' ORDER BY conname))")
  console.log("  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid")
  console.log("  JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND c.contype='c';")
  console.log("")
  console.log("Then commit the file.")
}

main().catch(err => {
  console.error("Snapshot failed:", err instanceof Error ? err.message : err)
  process.exit(1)
})
