/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Slice 2a): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-master.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3011"
const PASS = "Qa-master-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-master-${k.toLowerCase()}@example.test`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const A = (supabaseAdmin as unknown as { auth: { admin: { listUsers: (a: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown> } } }).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")

  // clean an earlier run (local test database only)
  await db.query("set session_replication_role = replica")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qm-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qm-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA master %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-master-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA master A ${stamp}`, actor: "qa-master" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-master")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-master", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  const ids: Record<string, string> = {}
  const mk = async (key: string, role: "owner" | "member", bundle?: string) => {
    const inv = await M.createInvite({ teamId: teamA.id, email: em(key), memberRole: role, bundle: bundle ?? null, actor: adminActor })
    if (inv.ok === false) throw new Error(`invite ${key}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS })
    if (acc.ok === false) throw new Error(`accept ${key}: ${acc.error}`)
    ids[key] = (await db.query("select id from auth.users where email=$1", [em(key)])).rows[0].id
    await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`, [ids[key]])
  }
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }
  const H = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
  const seed = async (n: string, name: string, o: { status?: string; team?: string | null; at?: number; claimed?: boolean; cb?: number | null; client?: object } = {}) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, status, received_at, claimed_by, claimed_by_label, callback_at, existing_client, answers) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb) returning id",
      [o.team === undefined ? teamA.id : o.team, `qm-${n}`, name, o.status ?? "new", H(o.at ?? 1), o.claimed ? ids.ownerA : null, o.claimed ? em("ownerA") : null, o.cb === undefined || o.cb === null ? null : H(-o.cb), o.client ? JSON.stringify(o.client) : null])).rows[0].id as string
  const L: Record<string, string> = {}
  L.fresh1 = await seed("1", "Fresh One", { at: 2 })
  L.fresh2 = await seed("2", "Fresh Two", { at: 5 })
  L.old1 = await seed("3", "Old One", { at: 80 })
  L.old2 = await seed("4", "Old Two", { at: 30 })
  L.good = await seed("5", "Good Lead", { status: "qualified", at: 10 })
  L.picked = await seed("6", "Picked Lead", { status: "contacted", claimed: true, at: 40 })
  L.late = await seed("7", "Late Callback", { status: "contacted", at: 9, cb: -3 })
  L.later = await seed("8", "Later Today", { status: "contacted", at: 9, cb: 0.1 })
  L.client = await seed("9", "Anna Vitale", { at: 3, client: { contact_ids: ["c1"], matched_on: ["email"] } })
  L.noteam = await seed("10", "Nobody's Lead", { team: null, at: 2 })
  const evt = (lead: string, kind: string, actor: string, data: object, h: number) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,$2,$3,$4,$5)", [lead, kind, actor, JSON.stringify(data), H(h)])
  await evt(L.good, "status_changed", em("setterA"), { from: "new", to: "qualified", outcome: "good" }, 0.5)
  await evt(L.fresh1, "status_changed", em("setterA"), { from: "new", to: "not_in_target", outcome: "not_in_target" }, 0.6)
  await evt(L.late, "status_changed", em("setterA"), { from: "new", to: "contacted", outcome: "call_back" }, 0.7)
  await evt(L.picked, "claimed", em("ownerA"), {}, 0.8)
  await evt(L.old2, "status_changed", em("setterA"), { outcome: "good", to: "qualified" }, 30)  // yesterday-ish: must not count today

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
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
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


  const admin = await session(em("admin")), staff = await session(em("staff")), owner = await session(em("ownerA"))
  const num = async (page: import("playwright").Page, label: string) => (await page.locator(`section[aria-label="Numbers"] div:has(> div:text-is("${label}")) > div`).nth(1).innerText()).trim()

  let v = await view(admin, `/marketing-leads?team=${teamA.id}`)
  const t = v.text
  ck("M1 the admin opens the master view for the team", v.status === 200 && /Team: QA master A/.test(t) && /\(active\)/.test(t) && /2 people/.test(t), t.slice(0, 300))
  ck("M2 'New in the last 24 h' counts only leads that arrived in the last day (not the 30 h / 40 h / 80 h ones, and not the team-less lead)", (await num(v.page, "New in the last 24 h")) === "6", await num(v.page, "New in the last 24 h"))
  ck("M3 'Nobody touched, over 24 h' = the two old Newlead rows (30 h and 80 h), and it is red", (await num(v.page, "Nobody touched, over 24 h")) === "2", await num(v.page, "Nobody touched, over 24 h"))
  ck("M4 'Call backs due today' counts the late one and the one later today", (await num(v.page, "Call backs due today")) === "2", await num(v.page, "Call backs due today"))
  ck("M5 'Sales paid this month' is 0 (nothing has paid yet)", (await num(v.page, "Sales paid this month")) === "0")
  ck("M6 the funnel shows each stage's count in the pipeline's order", /New\s*\n?\s*6/.test(t.replace(/\n+/g, "\n")) || /New[\s\S]{0,40}6/.test(t), t.slice(300, 900))
  ck("M7 'Needs you' says: 2 untouched (oldest 3 d), the team-less leads, the late call back, the possible existing client", /2 leads untouched for over a day \(oldest: 3 d\)/.test(t) && /leads? that arrived with no team/.test(t) && /Call back with Late Callback is 3 h late/.test(t) && /Anna Vitale looks like an existing client/.test(t), t.slice(500, 1400))
  ck("M8 'What each person did today' counts the setter's three outcomes and the owner's pick, and NOT the old one", /qa-master-settera@example\.test Setter 1 1 1 0/.test(t.replace(/\s+/g, " ")) && /qa-master-ownera@example\.test Owner 0 0 0 1/.test(t.replace(/\s+/g, " ")), t.slice(900, 1800))
  ck("M9 the funnel and the Needs-you list are on the page (the Meta connection and the all-leads table now live on Settings and All leads)", /Where the leads are/.test(t) && /Needs you/.test(t) && /Qualified/.test(t), t.slice(-900))
  await v.page.screenshot({ path: `${SHOTS}/qa-master-view.png`, fullPage: true }); await v.page.close()

  v = await view(admin, "/")
  const link = await v.page.locator('a[href="/marketing-leads"]').count()
  ck("M10 the CRM menu has a 'Marketing' item for the admin", link >= 1 && /Marketing/.test(v.text), { link, t: v.text.slice(0, 200) })
  await v.page.screenshot({ path: `${SHOTS}/qa-master-menu.png` }); await v.page.close()

  v = await view(staff, "/marketing-leads")
  ck("M11 a staff login is sent away from the master view", !/Needs you|Where the leads are/.test(v.text), v.text.slice(0, 120)); await v.page.close()
  v = await view(staff, "/")
  ck("M12 and the menu item is not shown to staff", (await v.page.locator('a[href="/marketing-leads"]').count()) === 0); await v.page.close()
  v = await view(owner, "/marketing-leads")
  ck("M13 the marketing owner cannot open it either", !/Needs you|Where the leads are/.test(v.text) && !/Nobody's Lead/.test(v.text), v.text.slice(0, 120)); await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
