/* eslint-disable no-console */
/* sandbox only: a company's status changes → the trigger records it → the runner posts ONE staff-only note in the Calendar's What's New */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"
async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const { processAccountStatusEvents } = await import("@/lib/accounts/status-change")
  const acct = (await q("select id, status from accounts where company_name='Test Company LLC'"))[0]
  const start = acct.status as string
  const marker = new Date().toISOString()
  try {
    await q("update accounts set status='Suspended' where id=$1", [acct.id])
    await q("update accounts set status='Active' where id=$1", [acct.id])
    await q("update accounts set updated_at = updated_at where id=$1", [acct.id]) // not a status change
    const ev = await q("select old_status, new_status from account_status_events where account_id=$1 and created_at >= $2 order by created_at", [acct.id, marker])
    ck("1 the trigger recorded exactly the two real changes", ev.length === 2 && ev[0].new_status === "Suspended" && ev[1].new_status === "Active", ev)
    const r = await processAccountStatusEvents({ budgetMs: 60_000 })
    ck("2 the runner told staff about both", r.notified >= 2 && r.failed === 0, r)
    const notes = await q("select message, sender_type, contact_id from portal_messages where account_id=$1 and message like '%kind=account_status_changed%' and created_at >= $2 order by created_at", [acct.id, marker])
    ck("3 two staff-only notes exist", notes.length === 2 && notes.every((n) => n.sender_type === "system" && n.contact_id === null), notes.length)
    ck("4 the first says Suspended with the banner line, the second says Active again", /moved to Suspended/.test(notes[0]?.message) && /banner and limited access/.test(notes[0]?.message) && /is Active again/.test(notes[1]?.message), notes.map((n) => n.message.slice(0, 120)))
    const again = await processAccountStatusEvents({ budgetMs: 60_000 })
    const n2 = (await q("select count(*)::int n from portal_messages where account_id=$1 and message like '%kind=account_status_changed%' and created_at >= $2", [acct.id, marker]))[0].n
    ck("5 a second run adds nothing", n2 === 2 && again.notified === 0, { n2, again })
    const open = (await q("select count(*)::int n from account_status_events where account_id=$1 and handled_at is null", [acct.id]))[0].n
    ck("6 nothing is left waiting", open === 0, open)
  } finally {
    await q("update accounts set status=$2 where id=$1", [acct.id, start]).catch(() => undefined)
    await q("delete from portal_messages where account_id=$1 and message like '%kind=account_status_changed%' and created_at >= $2", [acct.id, marker]).catch(() => undefined)
    await q("delete from account_status_events where account_id=$1 and created_at >= $2", [acct.id, marker]).catch(() => undefined)
    console.log(`\n${pass} passed, ${fail} failed`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
