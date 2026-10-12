/* eslint-disable no-console, no-restricted-syntax -- a SANDBOX check of the CRM's own merge_contacts() on throw-away QA Test contacts */
/**
 * Before merging two real duplicate contacts in production: prove in the SANDBOX that merge_contacts() moves the company link,
 * the owner-list row, the chat messages and a hidden person storage onto the winner, and keeps a restore snapshot.
 * Runs over a DIRECT database connection (owner rights), the same way the production merge runs — through the API's restricted
 * connection the function cannot see the table links and moves nothing. Refuses to run against production.
 * Run: npx tsx scripts/crm-store/qa-cutover/merge-contacts-sandbox-check.ts
 */
import { config } from "dotenv"
import { randomBytes } from "crypto"
import { Client } from "pg"
import { check, summary } from "./qa-http"
config({ path: ".env.local" })

async function main() {
  const url = process.env.SUPABASE_DB_URL ?? ""
  if (!url.includes("xjcxlmlpeywtwkhstjlw") || url.includes("ydzipybqeebtpcvsbtvs")) throw new Error("refusing to run: not the sandbox database")
  const db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows
  const tag = randomBytes(3).toString("hex")
  const mk = async (email: string) => (await q("insert into contacts (full_name, first_name, last_name, email) values ($1,'QA',$2,$3) returning id", [`QA Test Merge ${tag}`, `Merge ${tag}`, email]))[0].id as string
  const winner = await mk(`qa-merge-winner-${tag}@example.test`)
  const loser = await mk(`qa-merge-loser-${tag}@example.test`)
  const acct = (await q("select id from accounts where company_name='Uxio Test LLC'"))[0].id as string
  await q("insert into account_contacts (account_id, contact_id, role, is_primary) values ($1,$2,'Member',false)", [acct, loser])
  const member = (await q("insert into members (account_id, member_type, full_name, email, contact_id, ownership_pct) values ($1,'individual',$2,$3,$4,0) returning id", [acct, `QA Test Merge ${tag}`, `qa-merge-loser-${tag}@example.test`, loser]))[0].id as string
  const owner = (await q("select store_ensure_owner('person', $1) as id", [loser]))[0].id as string

  const res = (await q("select merge_contacts($1::uuid,$2::uuid,'qa-sandbox-check') as r", [loser, winner]))[0].r as { ok?: boolean; rows_reassigned?: number; reassignment?: Record<string, number> }
  console.log("      reassignment:", JSON.stringify(res.reassignment))
  check("M1 the merge runs and moves rows", res.ok === true && (res.rows_reassigned ?? 0) >= 3, JSON.stringify(res))
  const links = await q("select contact_id from account_contacts where account_id=$1 and contact_id = any($2)", [acct, [winner, loser]])
  check("M2 the company link now belongs to the winner only", links.length === 1 && links[0].contact_id === winner, JSON.stringify(links))
  check("M3 the owner-list row points at the winner", (await q("select contact_id from members where id=$1", [member]))[0].contact_id === winner, "")
  check("M4 the hidden person storage moved to the winner", (await q("select contact_id from store_owners where id=$1", [owner]))[0].contact_id === winner, "")
  const lc = (await q("select merged_into, email from contacts where id=$1", [loser]))[0]
  check("M5 the loser is kept as a tombstone (merged_into set, email blanked)", lc.merged_into === winner && lc.email === null, JSON.stringify(lc))
  const wc = (await q("select alt_emails from contacts where id=$1", [winner]))[0]
  check("M6 the loser's email is kept on the winner as an alternate", (wc.alt_emails ?? []).includes(`qa-merge-loser-${tag}@example.test`), JSON.stringify(wc))
  check("M7 a restore snapshot was logged", (await q("select id from contact_merge_log where loser_id=$1", [loser])).length === 1, "")
  await db.end()
  summary()
}
main().catch((e) => { console.error(e); process.exit(1) })
