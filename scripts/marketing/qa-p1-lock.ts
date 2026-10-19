/* eslint-disable no-console */
/* LOCAL private stack only: proves a MARKETING token (and an anonymous one) can read no internal table directly through the
   database's REST API, and that it can read only its own team's marketing rows (TD Marketing P1, dev job 9aec66fa). */
import { config } from "dotenv"
config({ path: ".env.local" })
import crypto from "node:crypto"
import { execSync } from "node:child_process"
import { Client } from "pg"

const API = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
if (!API.includes("127.0.0.1")) throw new Error("local private stack only")

function jwtSecret(): Buffer {
  const name = execSync("docker ps --format '{{.Names}}' | grep '^supabase_rest_tdlocal-claude-circlback' | head -1").toString().trim()
  const env = execSync(`docker inspect ${name} --format '{{range .Config.Env}}{{println .}}{{end}}'`).toString()
  const m = env.match(/^PGRST_JWT_SECRET=(.+)$/m)
  if (!m) throw new Error("no jwt secret")
  // newer stacks give a key SET; the symmetric ("oct") key is the one that signs HS256 test tokens
  try {
    const keys = JSON.parse(m[1]).keys as Array<{ kty: string; k?: string }>
    const oct = keys.find(k => k.kty === "oct" && k.k)
    if (oct?.k) return Buffer.from(oct.k, "base64url")
  } catch { /* plain string secret */ }
  return Buffer.from(m[1])
}
const b64 = (o: object | Buffer) => Buffer.from(o instanceof Buffer ? o : JSON.stringify(o)).toString("base64url")
function sign(payload: object, secret: Buffer) {
  const head = b64({ alg: "HS256", typ: "JWT" })
  const body = b64({ aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, ...payload })
  const sig = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")
  return `${head}.${body}.${sig}`
}
async function rest(path: string, token: string): Promise<{ status: number; count: number | null }> {
  const r = await fetch(`${API}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${token}`, Prefer: "count=exact" } })
  const cr = r.headers.get("content-range") ?? ""
  const n = cr.split("/")[1]
  return { status: r.status, count: n && n !== "*" ? Number(n) : null }
}

async function main() {
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL })
  await db.connect()
  let pass = 0, fail = 0
  const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
  const secret = jwtSecret()

  // two teams, one marketing owner in team A, one member in team B
  const stamp = Date.now()
  const tA = (await db.query("insert into marketing_teams(name,status,created_by) values($1,'active','qa-p1') returning id", [`QA lock A ${stamp}`])).rows[0].id
  const tB = (await db.query("insert into marketing_teams(name,status,created_by) values($1,'active','qa-p1') returning id", [`QA lock B ${stamp}`])).rows[0].id
  const uA = crypto.randomUUID(), uB = crypto.randomUUID(), uStaff = crypto.randomUUID()
  await db.query("insert into marketing_team_members(team_id,user_id,member_role,status) values($1,$2,'owner','active'),($3,$4,'member','active')", [tA, uA, tB, uB])
  await db.query("insert into marketing_settings(key,team_id,value,updated_by) values('qa_probe',$1,'\"a\"','qa'),('qa_probe',$2,'\"b\"','qa')", [tA, tB])
  const marketingA = sign({ sub: uA, email: "qa-owner@example.test", app_metadata: { role: "marketing" } }, secret)
  const marketingB = sign({ sub: uB, email: "qa-member@example.test", app_metadata: { role: "marketing" } }, secret)
  const staff = sign({ sub: uStaff, email: "qa-staff@example.test", app_metadata: { role: "team" } }, secret)

  // 1. EVERY public table that is not marketing's own: marketing and anonymous read nothing
  const tables: string[] = (await db.query("select tablename from pg_tables where schemaname='public' and tablename not like 'marketing\\_%' order by 1")).rows.map(r => r.tablename)
  const leaksMarketing: string[] = [], leaksAnon: string[] = []
  let withRows = 0
  for (const t of tables) {
    const total = Number((await db.query(`select count(*) from public."${t}"`)).rows[0].count)
    if (total > 0) withRows++
    const m = await rest(`${t}?select=*&limit=1`, marketingA)
    if (m.status === 200 && (m.count ?? 0) > 0) leaksMarketing.push(t)
    const a = await rest(`${t}?select=*&limit=1`, ANON)
    if (a.status === 200 && (a.count ?? 0) > 0) leaksAnon.push(t)
  }
  ck(`1 marketing token reads NO row of ${tables.length} internal tables (${withRows} of them hold data)`, leaksMarketing.length === 0, leaksMarketing)
  ck("2 anonymous key reads NO row of those tables", leaksAnon.length === 0, leaksAnon)

  // 3. the test is not vacuous: a staff token still reads the tables it is meant to read, and marketing reads none of them
  const staffReads: string[] = []
  for (const t of tables) {
    const r = await rest(`${t}?select=*&limit=1`, staff)
    if (r.status === 200 && (r.count ?? 0) > 0) staffReads.push(t)
  }
  ck(`3 a staff token still reads ${staffReads.length} tables (policies unchanged for staff), and marketing reads none of them`, staffReads.length > 0 && staffReads.every(t => !leaksMarketing.includes(t)), staffReads.slice(0, 5))

  // 4. marketing reads ONLY its own team
  const ownTeams = await rest("marketing_teams?select=id", marketingA)
  ck("4 owner A sees exactly one team (its own)", ownTeams.status === 200 && ownTeams.count === 1, ownTeams)
  const setsA = await fetch(`${API}/rest/v1/marketing_settings?select=team_id,value&key=eq.qa_probe`, { headers: { apikey: ANON, Authorization: `Bearer ${marketingA}` } }).then(r => r.json())
  ck("5 owner A sees only team A's setting, not team B's", Array.isArray(setsA) && setsA.length === 1 && setsA[0].team_id === tA, setsA)
  const guess = await rest(`marketing_teams?select=id&id=eq.${tB}`, marketingA)
  ck("6 owner A guessing team B's id gets nothing", guess.count === 0, guess)
  const membersA = await rest("marketing_team_members?select=id", marketingA)
  ck("7 owner A sees only team A's member list (1 row)", membersA.count === 1, membersA)
  const termsMember = await rest("marketing_commission_terms?select=id", marketingB)
  ck("8 a plain member reads no commission terms", termsMember.count === 0, termsMember)
  const invites = await rest("marketing_invites?select=id", marketingA)
  ck("9 nobody but the server reads invites", invites.count === 0, invites)

  // 10. writes from a marketing token are refused everywhere we try
  const w = await fetch(`${API}/rest/v1/marketing_teams`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${marketingA}`, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ name: "hacked" }) })
  ck("10 a marketing token cannot create a team", w.status >= 400, w.status)
  const w2 = await fetch(`${API}/rest/v1/marketing_settings?key=eq.qa_probe`, { method: "PATCH", headers: { apikey: ANON, Authorization: `Bearer ${marketingA}`, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ value: "\"hacked\"" }) })
  const w2b = await w2.text()
  ck("11 a marketing token cannot change a setting", (await db.query("select count(*) from marketing_settings where key='qa_probe' and value='\"hacked\"'")).rows[0].count === "0", w2b)
  const w3 = await fetch(`${API}/rest/v1/system_docs`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${marketingA}`, "Content-Type": "application/json" }, body: JSON.stringify({ slug: "x", title: "x", content: "x" }) })
  ck("12 a marketing token cannot write into an internal table", w3.status >= 400, w3.status)

  // 14. database functions that trust a user id: refused to anonymous, marketing and staff tokens alike (service key only)
  const rpc = async (fn: string, body: object, token: string) =>
    (await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status
  const callsMarketing = await rpc("get_team_threads", { p_user_id: uStaff }, marketingA)
  const callsAnon = await rpc("get_team_threads", { p_user_id: uStaff }, ANON)
  const searchMarketing = await rpc("search_team_messages", { p_user_id: uStaff, p_query: "a" }, marketingA)
  ck("14 marketing and anonymous cannot call the team-chat functions with someone else's id", callsMarketing >= 400 && callsAnon >= 400 && searchMarketing >= 400, { callsMarketing, callsAnon, searchMarketing })

  // 15. the anonymous role keeps exactly the three grants the browser needs
  const anonGrants = (await db.query("select table_name, privilege_type from information_schema.role_table_grants where grantee='anon' and table_schema='public' order by 1,2")).rows.map(r => `${r.table_name}:${r.privilege_type}`)
  ck("15 anonymous holds only the 5 grants the signing pages need", anonGrants.join(",") === "form_8832_applications:SELECT,form_8832_applications:UPDATE,member_info_requests:SELECT,signature_requests:SELECT,signature_requests:UPDATE", anonGrants)

  // 13. no public table left without row-level security
  const off = (await db.query("select tablename from pg_tables where schemaname='public' and not rowsecurity")).rows.map(r => r.tablename)
  ck("13 every public table has row-level security on", off.length === 0, off)

  // clean up
  await db.query("delete from marketing_teams where id in ($1,$2)", [tA, tB])
  console.log(`\n${pass} pass, ${fail} fail`)
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
