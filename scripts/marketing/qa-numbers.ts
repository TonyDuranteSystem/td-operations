/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Money): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-nr.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3011"
const PASS = "Qa-ws-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-nr-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qn-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qn-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qn-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA nr %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-nr-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA nr A ${stamp}`, actor: "qa-nr" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-nr")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-nr", permissions: [] as string[] }
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
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter"); await mk("aleA", "member", "content")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }



  const mkLead = async (n: string, name: string, ad: string | null, status = "qualified", ageH = 1) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, answers) values ($1,$2,$3,$4,'+393330000000',$5,$6, now() - ($7 || ' hours')::interval,'[]'::jsonb) returning id", [teamA.id, `qn-${n}`, name, `qn${n}@example.test`, status, ad, String(ageH)])).rows[0].id as string
  const l1 = await mkLead("1", "Good One", "Ad Alpha"), l2 = await mkLead("2", "Good Two", "Ad Alpha"), l3 = await mkLead("3", "Good Three", "Ad Beta"), l4 = await mkLead("4", "Nope One", "Ad Alpha"), l5 = await mkLead("5", "Later One", null), l6 = await mkLead("6", "Old Good", "Ad Beta", "qualified", 24 * 30)
  const evt = (lead: string, outcome: string, extra: object, hoursAgo: number) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,'status_changed',$2,$3, now() - ($4 || ' hours')::interval)", [lead, em("setterA"), JSON.stringify({ from: "new", to: "x", outcome, ...extra }), String(hoursAgo)])
  for (const l of [l1, l2, l3]) await evt(l, "good", {}, 0.2)
  await evt(l4, "not_in_target", { reason: "wrong_profile" }, 0.2)
  await evt(l5, "call_back", {}, 0.2)
  await evt(l6, "good", {}, 24 * 30)
  await db.query("insert into marketing_sales (team_id, lead_id, kind, amount_cents, currency, status, created_by, paid_at, paid_amount_cents) values ($1,$2,'strategic_call',30000,'USD','paid','qa-nr', now(), 30000)", [teamA.id, l1])

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





  const setter = await session(em("setterA")), owner = await session(em("ownerA")), ale = await session(em("aleA"))
  const body = (page: import("playwright").Page) => page.locator("body").innerText().then(t => t.replace(/\s+/g, " "))
  const nav = (page: import("playwright").Page) => page.locator('nav[aria-label="Workspace"]').innerText().then(t => t.replace(/\s+/g, " "))
  const tile = (page: import("playwright").Page, id: string) => page.getByTestId(id).innerText()

  let v = await view(setter, "/marketing/call-list")
  const sn = await nav(v.page)
  ck("N1 the setter's menu has My numbers (a real link, not 'soon') and no Reports", /My numbers/.test(sn) && !/My numbers\s*soon/i.test(sn) && !/Reports/.test(sn), sn); await v.page.close()

  v = await view(setter, "/marketing/my-numbers?period=today")
  const t = { worked: await tile(v.page, "worked"), good: await tile(v.page, "good"), rate: await tile(v.page, "rate"), paid: await tile(v.page, "paid") }
  ck("N2 today: 5 leads marked, 3 Good, Good rate 75% (3 of 4), 1 Good lead already paid a call", t.worked === "5" && t.good === "3" && t.rate.startsWith("75%") && t.paid === "1", t)
  const ended = await v.page.locator('section[aria-label="Where your leads ended"]').innerText().then(x => x.replace(/\s+/g, " "))
  ck("N3 where his leads ended: Good 3, Not in target 1, Call back 1", /Good 3/.test(ended) && /Not in target 1/.test(ended) && /Call back 1/.test(ended), ended)
  await v.page.screenshot({ path: `${SHOTS}/qa-nr-mynumbers.png`, fullPage: true }); await v.page.close()
  v = await view(setter, "/marketing/my-numbers?period=all")
  ck("N4 all time adds the old Good one: 6 marked, 4 Good", (await tile(v.page, "worked")) === "6" && (await tile(v.page, "good")) === "4", [await tile(v.page, "worked"), await tile(v.page, "good")]); await v.page.close()
  v = await view(owner, "/marketing/my-numbers?period=today")
  ck("N5 the owner has his own numbers too, and they are NOT the setter's (his marks only)", (await tile(v.page, "worked")) === "0", await tile(v.page, "worked")); await v.page.close()

  v = await view(setter, "/marketing/reports")
  ck("N6 a setter cannot open Reports", /do not have access to Reports/.test(await body(v.page))); await v.page.close()

  v = await view(owner, "/marketing/reports?period=today")
  const why = await v.page.locator('section[aria-label="Why leads were not in target"]').innerText().then(x => x.replace(/\s+/g, " "))
  ck("N7 Reports (owner): why leads were not in target = Wrong profile 1", /Wrong profile 1/.test(why), why)
  const ads = await v.page.locator('section[aria-label="Leads by ad"]').innerText().then(x => x.replace(/\s+/g, " "))
  ck("N8 Leads by ad (today): Ad Alpha 3 leads, 2 Good, 1 Not in target, 1 paid; Ad Beta 1 lead; No ad name 1; the 30-day-old lead is not in today", /Ad Alpha 3 2 1 1/.test(ads) && /Ad Beta 1 1 0 0/.test(ads) && /No ad name 1 0 0 0/.test(ads) && /not connected/.test(ads), ads)
  const st = await v.page.locator('section[aria-label="Setters"]').innerText().then(x => x.replace(/\s+/g, " "))
  ck("N9 the owner sees the Setters table: the setter 5 marked, 3 Good, 1 Not in target, 75%, 1 paid", /qa-nr-settera@example\.test 5 3 1 75% 1/.test(st), st)
  await v.page.screenshot({ path: `${SHOTS}/qa-nr-reports.png`, fullPage: true })
  ck("N10 the owner's menu has Reports as a real link", !/Reports\s*soon/i.test(await nav(v.page))); await v.page.close()

  v = await view(ale, "/marketing/reports?period=all")
  ck("N11 the ad person sees why-not-in-target and the ads, but NOT the Setters table", (await v.page.locator('section[aria-label="Leads by ad"]').count()) === 1 && (await v.page.locator('section[aria-label="Setters"]').count()) === 0, (await body(v.page)).slice(0, 200)); await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
