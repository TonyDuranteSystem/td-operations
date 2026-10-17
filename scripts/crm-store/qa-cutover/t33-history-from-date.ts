/* eslint-disable no-console */
/* sandbox only: seed / check / clean the "new owner sees history from a date" test (dev job d14e823f)
   usage: npx tsx scripts/crm-store/qa-cutover/t33-history-from-date.ts seed|check|clean */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"

async function main() {
  const mode = process.argv[2]
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const acct = (await q("select id from accounts where company_name='Test Company LLC'"))[0].id as string
  const contact = (await q("select id from contacts where full_name='Test Client'"))[0].id as string
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  try {
    if (mode === "seed") {
      const link = (await q("select history_visible_from from account_contacts where account_id=$1 and contact_id=$2", [acct, contact]))[0]
      if (!link) throw new Error("Test Client is not linked to Test Company LLC")
      console.log("before:", JSON.stringify(link))
      await q("update account_contacts set history_visible_from = now() - interval '1 hour' where account_id=$1 and contact_id=$2", [acct, contact])
      const mk = async (name: string, ageHours: number, open: boolean) => (await q(
        "insert into documents (file_name, account_id, category, category_name, document_type_name, portal_visible, drive_file_id, created_at, visible_to_new_owners, status) values ($1,$2,1,'Company','ZZ T33',true,$3, now() - ($4 || ' hours')::interval, $5, 'processed') returning id",
        [name, acct, "storage:zz-t33/" + name, String(ageHours), open]))[0].id as string
      const oldId = await mk("ZZ T33 OLD.pdf", 48, false)
      const openId = await mk("ZZ T33 OLD OPENED.pdf", 48, true)
      const newId = await mk("ZZ T33 NEW.pdf", 0, false)
      console.log(JSON.stringify({ acct, contact, oldId, openId, newId }))
    } else if (mode === "check") {
      const docs = await q("select file_name, created_at, visible_to_new_owners from documents where file_name like 'ZZ T33%' order by file_name")
      console.log(JSON.stringify(docs))
      ck("3 test documents exist", docs.length === 3, docs)
    } else if (mode === "helpers") {
      // the real helpers against the real sandbox tables
      const { historyFromForNewLink, getHistoryCutoff, startHistoryFromNow } = await import("@/lib/portal/history-cutoff")
      const ghost = (await q("insert into contacts (full_name) values ('ZZ T33 New Owner') returning id"))[0].id as string
      try {
        const withDocs = await historyFromForNewLink({ accountId: acct, contactId: ghost, choice: "today" })
        ck("a new person on a company with documents → a start date", typeof withDocs === "string", withDocs)
        const all = await historyFromForNewLink({ accountId: acct, contactId: ghost, choice: "all" })
        ck("choice 'all' → sees everything", all === null, all)
        const already = await historyFromForNewLink({ accountId: acct, contactId: contact, choice: "today" })
        ck("a person already linked is left alone", already === undefined, already)
        const noDocsAcct = (await q("select a.id from accounts a where not exists (select 1 from documents d where d.account_id=a.id and d.portal_visible) limit 1"))[0]?.id as string | undefined
        if (noDocsAcct) {
          const none = await historyFromForNewLink({ accountId: noDocsAcct, contactId: ghost, choice: "today" })
          ck("a company with no client-visible documents → no start date", none === null, none)
        }
        await q("insert into account_contacts (account_id, contact_id, role) values ($1,$2,'Member')", [acct, ghost])
        ck("start-from-now stamps a new link", (await startHistoryFromNow({ accountId: acct, contactId: ghost })) === true)
        ck("and it reads back", typeof (await getHistoryCutoff(acct, ghost)) === "string")
      } finally {
        await q("delete from account_contacts where contact_id=$1", [ghost])
        await q("delete from contacts where id=$1", [ghost])
      }
    } else if (mode === "clean") {
      await q("delete from documents where file_name like 'ZZ T33%'")
      await q("update account_contacts set history_visible_from = null where account_id=$1 and contact_id=$2", [acct, contact])
      console.log("cleaned")
    }
  } finally {
    if (mode === "check" || mode === "helpers") console.log(`\n${pass} passed, ${fail} failed`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
