/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Slice 2a): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-fill.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3011"
const PASS = "Qa-fill-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-fill-${k.toLowerCase()}@example.test`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const A = (supabaseAdmin as unknown as { auth: { admin: { listUsers: (a: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown> } } }).auth.admin
  const S = await import("@/lib/marketing/settings")

  // clean an earlier run (local test database only)
  await db.query("set session_replication_role = replica")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qf-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qf-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA fill %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-fill-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA fill A ${stamp}`, actor: "qa-fill" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-fill")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
  }
  await db.query("delete from contacts where email = 'fabrizio.sacchi@outlook.com'")
  await db.query("insert into contacts (full_name, email, phone) values ('Fabrizio Sacchi (QA client)', 'fabrizio.sacchi@outlook.com', '+40 757 906 127')")
  const ans = (o: Record<string, string>) => JSON.stringify(Object.entries(o).map(([name, v]) => ({ name, values: [v] })))
  const lead = async (n: string, a: string) => (await db.query("insert into marketing_leads (team_id, leadgen_id, status, answers) values ($1,$2,'new',$3::jsonb) returning id", [teamA.id, `qf-${n}`, a])).rows[0].id as string
  const L = {
    real: await lead("1", ans({ "che_attività_hai?": "servizi", "e-mail": "Fabrizio.Sacchi@Outlook.com", nome_e_cognome: "Fabrizio Sacchi", numero_di_telefono: "+40757906127" })),
    real2: await lead("2", ans({ "e-mail": "luca.qa@example.test", nome_e_cognome: "Luca Neri", numero_di_telefono: "+393331112233" })),
    test: await lead("3", ans({ "e-mail": "<test lead: dummy data for e-mail>", nome_e_cognome: "<test lead: dummy data for nome_e_cognome>", numero_di_telefono: "<test lead: dummy data for numero_di_telefono>" })),
    none: await lead("4", ans({ "che_attività_hai?": "x" })),
  }
  const row = async (id: string) => (await db.query("select full_name, email, phone, existing_client from marketing_leads where id=$1", [id])).rows[0]
  const missingNow = async () => (await db.query("select count(*)::int n from marketing_leads where full_name is null and email is null and phone is null")).rows[0].n as number

  const jwtSecret = (() => {
    const c = execSync("docker ps --format '{{.Names}}'").toString().split("\n").find(n => n.startsWith("supabase_auth_tdlocal-claude-circlback"))
    const env = execSync(`docker inspect ${c} --format '{{range .Config.Env}}{{println .}}{{end}}'`).toString()
    return env.split("\n").find(l => l.startsWith("GOTRUE_JWT_SECRET="))!.slice("GOTRUE_JWT_SECRET=".length)
  })()
  const browser = await chromium.launch()
  async function liftToAal2(ctx: BrowserContext) {
    const cookies = await ctx.cookies(BASE)
    const parts = cookies.filter(c => /^sb-.*-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => a.name.localeCompare(b.name))
    if (!parts.length) throw new Error("no session cookie")
    const base = parts[0].name.replace(/\.\d+$/, "")
    let raw = parts.map(x => decodeURIComponent(x.value)).join("")
    raw = raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : raw
    const sess = JSON.parse(raw)
    const claims = JSON.parse(Buffer.from(sess.access_token.split(".")[1], "base64url").toString("utf8"))
    claims.aal = "aal2"; claims.amr = [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }, ...(claims.amr ?? [])]
    sess.access_token = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(new TextEncoder().encode(jwtSecret))
    await db.query("update auth.sessions set aal='aal2' where id=$1", [claims.session_id])
    await ctx.clearCookies()
    await ctx.addCookies([{ name: base, value: "base64-" + Buffer.from(JSON.stringify(sess), "utf8").toString("base64url"), domain: new URL(BASE).hostname, path: "/", httpOnly: false, secure: false, sameSite: "Lax" }])
  }
  async function session(email: string): Promise<BrowserContext> {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 })
    await page.waitForTimeout(2500)
    await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', PASS); await page.click('button[type="submit"]')
    const until = Date.now() + 120000
    for (;;) { if ((await ctx.cookies(BASE)).some(c => /^sb-.*-auth-token/.test(c.name)) || Date.now() > until) break; await page.waitForTimeout(500) }
    await page.waitForTimeout(1500)
    await liftToAal2(ctx)
    await page.close()
    return ctx
  }
  const view = async (ctx: BrowserContext, path: string) => {
    for (let i = 0; ; i++) {
      try {
        const page = await ctx.newPage()
        const resp = await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 180000 })
        const text = (await page.locator("body").innerText()).slice(0, 4000)
        return { page, status: resp?.status() ?? 0, text }
      } catch (e) { if (i >= 3) throw e; await sleep(3000) }
    }
  }


  const admin = await session(em("admin")), staff = await session(em("staff"))
  const api = (ctx: BrowserContext, data: unknown) => ctx.request.post(`${BASE}/api/marketing-admin/leads/backfill-contacts`, { data }).then(async r => ({ status: r.status(), json: await r.json().catch(() => ({})) }))

  const before = await missingNow()
  let v = await view(admin, "/marketing-leads")
  ck("F1 the master page says how many leads have no name, email or phone, with a Step 1 button", new RegExp(`${before} leads? (has|have) no name, email or phone saved`).test(v.text) && /Step 1: count what can be filled in/.test(v.text), v.text.slice(0, 300))
  await v.page.getByRole("button", { name: "Step 1: count what can be filled in" }).click()
  await v.page.getByText(/can be filled in:/).waitFor({ timeout: 60000 })
  const txt = await v.page.locator("body").innerText()
  ck("F2 step 1 shows the count (3 of the 4 can be filled; 1 existing client; 1 Meta test lead) and changes nothing", /3 of \d+ leads can be filled in: 3 names, 2 emails, 2 phone numbers/.test(txt) && /1 look like existing TD clients/.test(txt) && /1 are Meta test leads/.test(txt) && (await missingNow()) === before, txt.slice(txt.indexOf("Leads"), txt.indexOf("Leads") + 400) || txt.slice(0, 500))
  await v.page.screenshot({ path: `${SHOTS}/qa-fill-step1.png`, fullPage: true })
  await v.page.getByRole("button", { name: /Step 2: fill in 3 leads/ }).click()
  await v.page.getByText(/leads filled in/).waitFor({ timeout: 60000 })
  const a = await row(L.real), b = await row(L.real2), t = await row(L.test), n = await row(L.none)
  ck("F3 step 2 fills the real leads: name, lower-cased email, phone", a.full_name === "Fabrizio Sacchi" && a.email === "fabrizio.sacchi@outlook.com" && a.phone === "+40757906127" && b.full_name === "Luca Neri" && b.email === "luca.qa@example.test" && b.phone === "+393331112233", { a, b })
  ck("F4 the lead that matches a TD client by email AND phone is flagged; the other is not", a.existing_client?.contact_ids?.length === 1 && a.existing_client?.matched_on?.length === 2 && b.existing_client === null, { a: a.existing_client, b: b.existing_client })
  ck("F5 the Meta test lead is named 'Meta test lead' with no dummy email or phone; the lead with no contact answers is untouched", t.full_name === "Meta test lead" && t.email === null && t.phone === null && n.full_name === null, { t, n })
  const ev = (await db.query("select kind from marketing_lead_events where lead_id=$1 order by id", [L.real])).rows.map(x => x.kind)
  ck("F6 the history of the flagged lead says details were filled in and that it may be a client", ev.join() === "details_filled,possible_existing_client", ev)
  await v.page.close()

  const again = await api(admin, { apply: true })
  ck("F7 running it again fills nothing more", again.status === 200 && again.json.report.filled === 0, again)
  const dry = await api(admin, {})
  ck("F8 a call with no body is a dry run (counts only)", dry.status === 200 && dry.json.report.apply === false, dry)
  const bad = await api(staff, { apply: true })
  ck("F9 a staff login is refused (403) and nothing changes", bad.status === 403, bad)
  const noJson = await admin.request.post(`${BASE}/api/marketing-admin/leads/backfill-contacts`, { data: "apply=true", headers: { "Content-Type": "text/plain" } })
  ck("F10 a plain-text (form-style) request is refused (415)", noJson.status() === 415, noJson.status())
  const anon = await (await browser.newContext()).request.post(`${BASE}/api/marketing-admin/leads/backfill-contacts`, { data: { apply: true }, maxRedirects: 0 })
  ck("F11 with no login it is refused", [401, 403, 307, 302].includes(anon.status()), anon.status())
  v = await view(admin, "/marketing-leads")
  const left = await missingNow()
  ck("F12 the page now lists the filled leads by name, and the warning only counts what is still empty", /Fabrizio Sacchi/.test(v.text) && /Luca Neri/.test(v.text) && new RegExp(`${left} leads? (has|have) no name`).test(v.text), v.text.slice(-600))
  await v.page.screenshot({ path: `${SHOTS}/qa-fill-after.png`, fullPage: true }); await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
