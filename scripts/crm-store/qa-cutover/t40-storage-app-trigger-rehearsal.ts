/* eslint-disable no-console */
/**
 * Storage Mac app, production rollout preparation (dev job 1992a087): REHEARSAL of the change-feed triggers on the SANDBOX database, exactly the
 * situations the production review was afraid of. Run: npx tsx scripts/crm-store/qa-cutover/t40-storage-app-trigger-rehearsal.ts
 * Proves: (1) the core CRM tables (accounts, contacts) carry NO change-feed trigger; (2) a storage write still SUCCEEDS when the log table is
 * deliberately broken (the trigger swallows its own error and only warns); (3) the OFF file stops the feed without data loss and the ON file
 * restarts it and forces one full refresh; (4) the three UNDO files run cleanly in the documented order (inside a transaction that is rolled back);
 * (5) the pre-flight refuses a database that lacks a column the triggers read.
 */
import { config } from "dotenv"
import { Client } from "pg"
import { readFileSync } from "fs"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL ?? ""
  if (!dbUrl.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("REFUSED: not the sandbox database")
  const db = new Client({ connectionString: dbUrl }); await db.connect()
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows
  const stamp = Date.now()
  const { rows: [f] } = await db.query(`select id, name from store_files where state='live' and name like 'QA %' limit 1`)
  if (!f) throw new Error("no QA file to rename")
  const original = f.name as string
  const logCount = async () => Number((await q(`select count(*) c from store_change_log`))[0].c)
  const rename = async (name: string) => { await db.query(`update store_files set name=$1 where id=$2`, [name, f.id]) }

  try {
    // 1 — no trigger on the core CRM tables
    const core = await q(`select c.relname, t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and t.tgname like 'trg_store_change_log%' and c.relname in ('accounts','contacts')`)
    check("1 NO change-feed trigger on accounts or contacts", core.length === 0, JSON.stringify(core))
    const mine = await q(`select c.relname from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname like 'trg_store_change_log%' order by 1`)
    check("2 exactly the three storage triggers exist", mine.map((r) => r.relname).join(",") === "store_files,store_folders,store_owners", JSON.stringify(mine))

    // 2 — a storage write survives a deliberately BROKEN log table
    await db.query(`alter table store_change_log add constraint zz_break_t40 check (false) not valid`)
    let wrote = false, errorText = ""
    const before = await logCount()
    try { await rename(`${original} (t40 ${stamp})`); wrote = true } catch (e) { errorText = e instanceof Error ? e.message : String(e) }
    await db.query(`alter table store_change_log drop constraint zz_break_t40`)
    const after = await logCount()
    const nameNow = (await q(`select name from store_files where id=$1`, [f.id]))[0].name
    check("3 with the log table BROKEN the storage write still succeeds (the trigger only warns)", wrote && nameNow.includes("t40") && after === before, `wrote=${wrote} ${errorText}`)
    await rename(original)

    // 3 — OFF / ON files
    await db.query(readFileSync("scripts/migrations/20261018-1300-storage-app-triggers-off.sql", "utf8"))
    const c0 = await logCount(); await rename(`${original} (t40b ${stamp})`)
    check("4 with the triggers OFF a storage write writes no feed row (and still saves)", (await logCount()) === c0, "")
    await db.query(readFileSync("scripts/migrations/20261018-1300-storage-app-triggers-on.sql", "utf8"))
    const tg = await q(`select tgenabled from pg_trigger where tgname like 'trg_store_change_log%'`)
    check("5 the ON file re-enables all three", tg.length === 3 && tg.every((r) => r.tgenabled === "O"), JSON.stringify(tg))
    const rs = await q(`select resync from store_changes_since('1'::xid8, 0, 5) limit 1`)
    check("6 after ON every old cursor is told to do one full refresh", rs[0]?.resync === true, JSON.stringify(rs))
    const c1 = await logCount(); await rename(original)
    check("7 with the triggers ON again a write is logged", (await logCount()) === c1 + 1, "")

    // 4 — UNDO in the documented order, rolled back
    await db.query("begin")
    let undoOk = true, undoErr = ""
    try { for (const file of ["20261018-0900-storage-app-p3a", "20261017-1500-storage-app-p1", "20261017-0100-storage-app-p0"]) await db.query(readFileSync(`scripts/migrations/${file}.UNDO.sql`, "utf8")) } catch (e) { undoOk = false; undoErr = e instanceof Error ? e.message : String(e) }
    const gone = undoOk ? Number((await q(`select count(*) c from pg_proc where proname like 'store_changes_%' or proname like 'storage_app_%' or proname like 'store_change_log%'`))[0].c) : -1
    await db.query("rollback")
    const back = Number((await q(`select count(*) c from pg_proc where proname like 'store_changes_%' or proname like 'storage_app_%' or proname like 'store_change_log%'`))[0].c)
    check("8 the three UNDO files run cleanly in order and remove every function (rolled back afterwards)", undoOk && gone === 0 && back > 0, `${undoErr} gone=${gone} back=${back}`)

    // 5 — the pre-flight refuses a database with a missing column (run the migration's own pre-flight block against a temporary missing column)
    const sql = readFileSync("scripts/migrations/20261017-0100-storage-app-p0.sql", "utf8")
    const pf = sql.slice(sql.indexOf("DO $preflight$"), sql.indexOf("END $preflight$;") + "END $preflight$;".length)
    await db.query("begin")
    await db.query(`alter table store_owners rename column private_user_id to private_user_id_x`)
    let refused = false, msg = ""
    try { await db.query(pf) } catch (e) { refused = true; msg = e instanceof Error ? e.message : String(e) }
    await db.query("rollback")
    check("9 the pre-flight REFUSES a database that lacks a column the triggers read", refused && msg.includes("private_user_id"), msg)
    let passes = true
    try { await db.query(pf) } catch { passes = false }
    check("10 and passes on the real sandbox schema", passes, "")
  } finally {
    await db.query(`alter table store_change_log drop constraint if exists zz_break_t40`).catch(() => null)
    await db.query(`update store_files set name=$1 where id=$2`, [original, f.id]).catch(() => null)
    await db.query(`alter table store_files enable trigger trg_store_change_log_file`).catch(() => null)
    await db.query(`alter table store_folders enable trigger trg_store_change_log_folder`).catch(() => null)
    await db.query(`alter table store_owners enable trigger trg_store_change_log_owner`).catch(() => null)
    await db.end()
  }
  summary()
}

main().catch((e) => { console.error("FATAL", e); process.exit(1) })
