/* eslint-disable no-console -- CLI gate: reports its findings on stdout. */
/**
 * CODE ↔ DATABASE CONTRACT CHECK.
 *
 * Asserts that every value the code can write into a CHECK-constrained column is a value
 * the database will actually accept.
 *
 * WHY THIS EXISTS — and why it is the only thing on the list that would have caught the
 * 2026-07-14 incident:
 *
 * The code wrote feed statuses (`needs_review`, `activation_crashed`) that production's
 * CHECK constraint did not permit. Every one of those writes was rejected. The code
 * discarded the error. The review queue therefore never worked — for months — while the
 * UI cheerfully rendered an empty "Needs Review" tab and everyone read empty as "nothing
 * to review".
 *
 * Three reviewers and five rounds of adversarial code review missed it, because all of us
 * were reading CODE against CODE. Nobody compared the code against the database it
 * actually writes to. A 32/32 green integration harness proved nothing, because the
 * harness's database (sandbox) had NO constraints at all — strictly more permissive than
 * production. A green run against a more permissive database is not evidence.
 *
 * "Review harder" does not fix that. This does.
 *
 * Usage:
 *   npx tsx scripts/check-db-constraints.ts            # checks the DB in .env.local (sandbox)
 *   npx tsx scripts/check-db-constraints.ts --prod     # checks production (needs .env.prod.local)
 *
 * Exits non-zero on any divergence.
 */

import { config } from "dotenv"
import { Client } from "pg"
import { FEED_STATUSES, MATCH_CONFIDENCES, FEED_SOURCES } from "../lib/finance/feed-vocabulary"

const useProd = process.argv.includes("--prod")
config({ path: useProd ? ".env.prod.local" : ".env.local" })

// A direct connection, the same mechanism `scripts/apply-migration.js` uses. The Supabase
// client cannot read pg_constraint, and the whole point of this check is to ask the
// database what it will actually accept — not to ask the code what it believes.
const DB_URL = process.env.SUPABASE_DB_URL

if (!DB_URL) {
  console.error("Missing SUPABASE_DB_URL — this check reads pg_constraint directly.")
  process.exit(1)
}

/**
 * Every code-side vocabulary that is backed by a database CHECK.
 * Add a row here whenever you add a constrained column — that is the whole contract.
 */
const CONTRACTS = [
  { table: "td_bank_feeds", column: "status", constraint: "td_bank_feeds_status_check", values: FEED_STATUSES },
  { table: "td_bank_feeds", column: "match_confidence", constraint: "td_bank_feeds_match_confidence_check", values: MATCH_CONFIDENCES },
  { table: "td_bank_feeds", column: "source", constraint: "td_bank_feeds_source_check", values: FEED_SOURCES },
] as const

/** Pull the literals out of a `col = ANY (ARRAY['a'::text, 'b'::text])` definition. */
function parseAllowed(def: string): string[] {
  return Array.from(def.matchAll(/'([^']+)'::text/g)).map(m => m[1])
}

async function main() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()

  const host = DB_URL!.replace(/:[^:@]+@/, ":****@")
  console.log(`Checking code↔DB contract against: ${host}\n`)

  const { rows } = await client.query<{ conname: string; def: string }>(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND c.contype = 'c'`,
  )
  await client.end()

  const byName = new Map(rows.map(r => [r.conname, r.def]))

  let failures = 0

  for (const contract of CONTRACTS) {
    const def = byName.get(contract.constraint)

    if (!def) {
      console.log(`FAIL  ${contract.table}.${contract.column} — constraint "${contract.constraint}" DOES NOT EXIST in this database.`)
      console.log(`      A missing constraint is not "safe": it means this environment accepts values production rejects,`)
      console.log(`      so every test that passes here proves nothing about production. That is exactly what happened.`)
      failures++
      continue
    }

    const allowed = parseAllowed(def)
    const missing = contract.values.filter(v => !allowed.includes(v))
    const extra = allowed.filter(v => !(contract.values as readonly string[]).includes(v))

    if (missing.length === 0 && extra.length === 0) {
      console.log(`PASS  ${contract.table}.${contract.column} — code and database agree (${allowed.length} values).`)
      continue
    }

    if (missing.length > 0) {
      console.log(`FAIL  ${contract.table}.${contract.column} — the code can write values the DATABASE WILL REJECT: ${missing.join(", ")}`)
      console.log(`      These writes will fail silently unless every caller checks the error. Add them to the CHECK via a migration.`)
      failures++
    }
    if (extra.length > 0) {
      console.log(`WARN  ${contract.table}.${contract.column} — the database allows values the code never writes: ${extra.join(", ")}`)
      console.log(`      Harmless, but it usually means a value was retired in code and left behind in the schema.`)
    }
  }

  console.log()
  if (failures > 0) {
    console.log(`RESULT: ${failures} contract violation(s). The code writes values this database will not accept.`)
    process.exit(1)
  }
  console.log("RESULT: code and database agree.")
}

main().catch(err => {
  console.error("Contract check crashed:", err)
  process.exit(1)
})
