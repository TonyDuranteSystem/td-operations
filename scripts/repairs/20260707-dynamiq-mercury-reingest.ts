/* eslint-disable no-console -- one-off repair; console output IS the audit record */
/**
 * Dynamiq 2024 Mercury re-ingest repair (2026-07-07, Antonio-approved plan).
 *
 * The workspace's Mercury file was originally parsed by the generic parser:
 * bank_name 'Bank', foreign-card rows mislabeled with their ORIGINAL currency
 * over USD-settled amounts (double conversion), and 33 Failed/Cancelled rows
 * ingested into the books. S1's seeded mapping parses the same file correctly
 * (1,956 Sent rows, settled USD, named account).
 *
 * THE HARD PART: 1,141 of the old rows carry HUMAN answers (manual: notes),
 * 262 AI bookings, 881 location stamps — the repair must not lose a single
 * human decision. Procedure:
 *   1. BACKUP  — full JSON of the old rows to storage (restore point).
 *   2. DELETE  — old rows by source_file_id (after backup only).
 *   3. REINGEST— re-enqueue the ingest job; the seeded mapping parses it.
 *      (delete must precede: same file sha → same source_file_id → the
 *      idempotency short-circuit would otherwise skip the re-ingest.)
 *   4. CARRY   — match old ↔ new rows by (date, amount) multisets and
 *      transplant category/subcategory/notes/hints/loc/related-party.
 *      Groups where the old duplicates had DIFFERENT answers are carried
 *      arbitrarily within the group and REPORTED for staff re-check.
 *   5. REPORT  — unmatched rows (both directions) and mixed groups printed;
 *      nothing silent. Old-only unmatched should be exactly the 33 non-Sent
 *      rows (correctly gone). Then staff Re-run the P&L.
 *
 * Modes:
 *   npx tsx scripts/repairs/20260707-dynamiq-mercury-reingest.ts plan
 *     → read-only: prints counts + what WOULD happen.
 *   … backup-delete   → steps 1-2 (requires REPAIR_CONFIRM=yes env)
 *   … carry           → step 4 (run after the re-ingest job completed)
 *
 * Target selection is explicit: WS_ID + SOURCE_ID below; the script refuses
 * anything else. DB via NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
 * from the environment (pass the prod values explicitly for the prod run).
 */
import { createClient } from "@supabase/supabase-js"
import * as dotenv from "dotenv"
dotenv.config({ path: process.env.REPAIR_ENV_FILE ?? ".env.local" })

const WS_ID = process.env.REPAIR_WS_ID ?? "3f43a0a7-34fa-438a-b3a3-6dee59bebf3e"
const SOURCE_ID = process.env.REPAIR_SOURCE_ID ?? "upload:c54cb9a41324ca639598895f8e6b0aacfc65ad5fd7762844331df72f50e6f1b6"
const STORAGE_PATH_HINT = process.env.REPAIR_FILE_PATH ?? `pnl-workspaces/${WS_ID}/c54cb9a41324ca63_statement_mercury_2024.csv`

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
if (!url || !key) { console.error("Missing SUPABASE env"); process.exit(1) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = createClient(url, key) as any

interface Row {
  id: string
  transaction_date: string
  description: string | null
  counterparty: string | null
  amount: number | string
  currency: string | null
  category: string
  subcategory: string | null
  notes: string | null
  ai_lean: string | null
  ai_bucket: string | null
  loc_code: string | null
  loc_source: string | null
  loc_confidence: string | null
  is_related_party: boolean | null
}

const COLS = "id, transaction_date, description, counterparty, amount, currency, category, subcategory, notes, ai_lean, ai_bucket, loc_code, loc_source, loc_confidence, is_related_party"

async function fetchRows(sourceId: string): Promise<Row[]> {
  const out: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("pnl_workspace_transactions")
      .select(COLS)
      .eq("workspace_id", WS_ID)
      .eq("source_file_id", sourceId)
      .order("id", { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

/** (date|amount) key — the invariant across old and new parses of the same file. */
const matchKey = (r: Row) => `${r.transaction_date}|${Number(r.amount).toFixed(2)}`

async function main() {
  const mode = process.argv[2]
  if (!["plan", "backup-delete", "carry"].includes(mode ?? "")) {
    console.error("usage: … (plan|backup-delete|carry)"); process.exit(1)
  }
  console.log(`target: ws=${WS_ID}\n        source=${SOURCE_ID}\n        db=${url.slice(0, 40)}…\n`)

  if (mode === "plan" || mode === "backup-delete") {
    const rows = await fetchRows(SOURCE_ID)
    const manual = rows.filter(r => (r.notes ?? "").startsWith("manual:")).length
    const ai = rows.filter(r => (r.notes ?? "").startsWith("ai:")).length
    const located = rows.filter(r => r.loc_source !== null).length
    console.log(`old rows: ${rows.length} (manual ${manual}, ai ${ai}, located ${located})`)
    if (rows.length === 0) { console.error("Nothing to repair — already deleted?"); process.exit(1) }

    if (mode === "plan") { console.log("PLAN ONLY — no writes. Next: backup-delete with REPAIR_CONFIRM=yes"); return }
    if (process.env.REPAIR_CONFIRM !== "yes") { console.error("REPAIR_CONFIRM=yes required for backup-delete"); process.exit(1) }

    // 1. BACKUP
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backupPath = `pnl-workspaces/backups/${WS_ID}/mercury-repair-${stamp}.json`
    const { error: upErr } = await db.storage
      .from("onboarding-uploads")
      .upload(backupPath, Buffer.from(JSON.stringify({ ws: WS_ID, source: SOURCE_ID, rows })), { contentType: "application/json", upsert: true })
    if (upErr) throw new Error(`Backup failed — ABORTING before any delete: ${upErr.message}`)
    console.log(`backup written: ${backupPath} (${rows.length} rows)`)

    // 2. DELETE (chunked)
    let deleted = 0
    for (let i = 0; i < rows.length; i += 200) {
      const ids = rows.slice(i, i + 200).map(r => r.id)
      const { data: del, error } = await db
        .from("pnl_workspace_transactions")
        .delete()
        .eq("workspace_id", WS_ID)
        .in("id", ids)
        .select("id")
      if (error) throw new Error(`Delete failed at chunk ${i}: ${error.message}`)
      deleted += (del ?? []).length
    }
    console.log(`deleted: ${deleted} old rows`)

    // 3. RE-ENQUEUE ingest (the worker parses via the seeded mapping)
    const { error: jobErr } = await db.from("job_queue").insert({
      job_type: "ingest_workspace_statement",
      payload: { workspace_id: WS_ID, path: STORAGE_PATH_HINT },
      related_entity_type: "pnl_workspace",
      related_entity_id: WS_ID,
      created_by: "repair:mercury-reingest",
    })
    if (jobErr) throw new Error(`Re-enqueue failed (delete already done — enqueue manually!): ${jobErr.message}`)
    console.log(`re-ingest job enqueued for ${STORAGE_PATH_HINT}`)
    console.log("→ wait for the job to complete (process-jobs cron ≤5 min), then run mode 'carry'.")
    console.log(`carry needs: REPAIR_BACKUP_PATH=${backupPath}`)
    return
  }

  // mode === 'carry'
  const backupPath = process.env.REPAIR_BACKUP_PATH
  if (!backupPath) { console.error("REPAIR_BACKUP_PATH required for carry"); process.exit(1) }
  const { data: blob, error: dlErr } = await db.storage.from("onboarding-uploads").download(backupPath)
  if (dlErr || !blob) throw new Error(`Backup download failed: ${dlErr?.message}`)
  const oldRows: Row[] = JSON.parse(Buffer.from(await blob.arrayBuffer()).toString()).rows
  const newRows = await fetchRows(SOURCE_ID)
  console.log(`carry: ${oldRows.length} old (backup) ↔ ${newRows.length} new (re-ingested)`)
  if (newRows.length === 0) { console.error("No new rows — did the re-ingest job complete?"); process.exit(1) }

  const oldByKey = new Map<string, Row[]>()
  for (const r of oldRows) {
    const k = matchKey(r)
    oldByKey.set(k, [...(oldByKey.get(k) ?? []), r])
  }

  let carried = 0, freshRows = 0
  const mixedGroups: string[] = []
  for (const nr of newRows) {
    const k = matchKey(nr)
    const candidates = oldByKey.get(k) ?? []
    const old = candidates.shift() // multiset consume
    if (!old) { freshRows++; continue }
    if (candidates.length > 0) {
      const decisions = new Set([old, ...candidates].map(r => `${r.category}|${r.subcategory}|${(r.notes ?? "").slice(0, 20)}`))
      if (decisions.size > 1 && !mixedGroups.includes(k)) mixedGroups.push(k)
    }
    // Nothing to carry from an untouched old row (uncategorized, no stamps).
    const hasSignal = old.category !== "uncategorized" || old.notes || old.ai_lean || old.ai_bucket || old.loc_code || old.is_related_party
    if (!hasSignal) continue
    const { error } = await db
      .from("pnl_workspace_transactions")
      .update({
        category: old.category,
        subcategory: old.subcategory,
        notes: old.notes,
        ai_lean: old.ai_lean,
        ai_bucket: old.ai_bucket,
        loc_code: old.loc_code,
        loc_source: old.loc_source,
        loc_confidence: old.loc_confidence,
        is_related_party: old.is_related_party,
      })
      .eq("id", nr.id)
      .eq("workspace_id", WS_ID)
    if (error) throw new Error(`Carry failed on ${nr.id}: ${error.message}`)
    carried++
  }
  const oldLeftover = Array.from(oldByKey.values()).flat()
  const leftoverManual = oldLeftover.filter(r => (r.notes ?? "").startsWith("manual:"))
  console.log(`carried bookings onto ${carried} rows; ${freshRows} new rows had no old counterpart (fresh)`)
  console.log(`old rows without a new counterpart: ${oldLeftover.length} (expected ≈ the non-Sent rows correctly excluded)`)
  if (leftoverManual.length > 0) {
    console.log(`⚠ ${leftoverManual.length} of those carried MANUAL answers — review:`)
    for (const r of leftoverManual.slice(0, 20)) console.log(`   ${r.transaction_date} ${Number(r.amount).toFixed(2)} ${String(r.description).slice(0, 40)} [${r.notes}]`)
  }
  if (mixedGroups.length > 0) {
    console.log(`⚠ ${mixedGroups.length} date|amount group(s) had MIXED old answers (carried in order) — staff re-check:`)
    for (const k of mixedGroups.slice(0, 20)) console.log(`   ${k}`)
  }
  console.log("→ done. Now Re-run P&L in the workspace (transfer pairs, policies, totals recompute).")
}

main().catch(e => { console.error("FATAL:", e); process.exit(1) })
