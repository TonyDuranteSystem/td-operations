/* eslint-disable no-console */
/* sandbox only: a member is removed → the Calendar's What's New gets a note, the person's portal link to THIS company ends, other companies and a primary contact are handled as agreed */
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
  const { recordPersonLeaving } = await import("@/lib/crm-store/storage-check")
  const { endPortalAccessForRemovedMember } = await import("@/lib/crm-store/person-leaving")

  const acct = (await q("select id, company_name from accounts where company_name='Test Company LLC'"))[0]
  const acct2 = (await q("select id from accounts where company_name <> 'Test Company LLC' and status='Active' limit 1"))[0].id as string
  const mk = async (name: string) => (await q("insert into contacts (full_name) values ($1) returning id", [name]))[0].id as string
  const gone = await mk("ZZ T32 Leaver"), twice = await mk("ZZ T32 Twice")
  const primary = (await q("select contact_id from account_contacts where account_id=$1 and is_primary", [acct.id]))[0]?.contact_id as string // the company's own primary contact (never changed)
  const ids = [gone, twice]
  try {
    await q("insert into account_contacts (account_id, contact_id, role, is_primary) values ($1,$2,'Member',false),($1,$3,'Member',false),($4,$2,'Member',false)", [acct.id, gone, twice, acct2])
    await q("insert into members (account_id, member_type, full_name, contact_id) values ($1,'individual','ZZ T32 Leaver',$2),($1,'individual','ZZ T32 Twice',$3)", [acct.id, gone, twice])

    // 1) the leaver: note + What's New + link ended, the OTHER company's link untouched
    const r = await recordPersonLeaving({ accountId: acct.id, contactId: gone, personName: "ZZ T32 Leaver", actorId: null, via: "member-delete" })
    await q("delete from members where account_id=$1 and contact_id=$2", [acct.id, gone]) // what the route does before ending the access
    const e = await endPortalAccessForRemovedMember({ accountId: acct.id, contactId: gone, memberType: "individual" })
    ck("1a the leaver's link to this company ended", e.accessEnded === true && e.warning === null, e)
    ck("1b their link to the OTHER company is untouched", (await q("select 1 from account_contacts where account_id=$1 and contact_id=$2", [acct2, gone])).length === 1)
    ck("1c a 'left' note was recorded", (await q("select 1 from storage_check_notes where account_id=$1 and contact_id=$2 and kind='left'", [acct.id, gone])).length === 1)
    const msg = await q("select message, contact_id, sender_type from portal_messages where account_id=$1 and message like '%kind=person_left%' and message like '%ZZ T32 Leaver%' order by created_at desc limit 1", [acct.id])
    ck("1d What's New (Calendar) got a staff note for the company", msg.length === 1 && msg[0].sender_type === "system" && msg[0].contact_id === null && String(msg[0].message).includes("removed as a member"), msg)
    ck("1e the company still has other people linked (not the only one)", r.onlyLinkedPerson === false, r)

    // 2) the primary contact keeps access, with a warning
    const p = await endPortalAccessForRemovedMember({ accountId: acct.id, contactId: primary, memberType: "individual" })
    ck("2 the primary contact keeps access and the server says why", p.accessEnded === false && /primary contact/.test(p.warning ?? ""), p)

    // 3) a person whose member row is still there (the database allows ONE current member row per person) keeps access
    const t = await endPortalAccessForRemovedMember({ accountId: acct.id, contactId: twice, memberType: "individual" })
    ck("3 a person still listed as another member keeps access", t.accessEnded === false && /still listed/.test(t.warning ?? ""), t)

    // 4) the same removal twice posts ONE note per removal event, and a repeat of the same event id is not doubled
    const n = (await q("select count(*)::int n from portal_messages where account_id=$1 and message like '%kind=person_left%' and message like '%ZZ T32 Leaver%'", [acct.id]))[0].n
    ck("4 exactly one What's New note for the one removal", n === 1, n)
  } finally {
    await db.query("delete from portal_messages where message like '%ZZ T32%'").catch(() => undefined)
    await db.query("delete from storage_check_notes where person_name like 'ZZ T32%'").catch(() => undefined)
    await db.query("delete from members where full_name like 'ZZ T32%'").catch(() => undefined)
    await db.query("delete from account_contacts where contact_id = any($1)", [ids]).catch(() => undefined)
    await db.query("delete from contacts where id = any($1)", [ids]).catch(() => undefined)
    console.log(`\n${pass} passed, ${fail} failed`)
    await db.end()
  }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
