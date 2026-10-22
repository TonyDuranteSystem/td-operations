/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, build step 3: Today): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-today.ts */
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
const em = (k: string) => `qa-td-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qt-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qt-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qt-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA td %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-td-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA td A ${stamp}`, actor: "qa-td" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-td")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-td", permissions: [] as string[] }
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





  const teamB = (await S.createTeam({ name: `QA td B ${stamp}`, actor: "qa-td" })).data!
  const romeHoursIn = (() => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()); return Number(p.find(x => x.type === "hour")!.value) + Number(p.find(x => x.type === "minute")!.value) / 60 })()
  const TODAY_AGO = Math.max(0.01, Math.min(1, romeHoursIn / 2)) // hours ago, always inside today's Rome day
  const mkLead = async (team: string, n: string, name: string, status: string, hoursOld: number, claimed: string | null = null) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, claimed_at, answers) values ($1,$2,$3,$4,'+393330000000',$5,'Ad Alpha', now() - ($6 || ' hours')::interval,$7,$8, case when $7::uuid is null then null else now() end,'[]'::jsonb) returning id", [team, `qt-${n}`, name, `qt${n}@example.test`, status, String(hoursOld), claimed, claimed ? em("ownerA") : null])).rows[0].id as string
  const evt = (lead: string, actor: string, kind: string, data: object, hoursAgo = TODAY_AGO) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,$2,$3,$4, now() - ($5 || ' hours')::interval)", [lead, kind, actor, JSON.stringify(data), String(hoursAgo)])
  const gA = await mkLead(teamA.id, "1", "Good Waiting A", "qualified", 5)
  await evt(gA, em("setterA"), "status_changed", { from: "new", to: "qualified", outcome: "good", note: "wants an LLC in Wyoming" })
  await mkLead(teamA.id, "2", "Fresh Lead", "new", 3)
  await mkLead(teamA.id, "3", "Stale One", "new", 30)
  await mkLead(teamA.id, "4", "Stale Two", "new", 90)
  const rj = await mkLead(teamA.id, "5", "Rejected Today", "not_in_target", 10)
  await evt(rj, em("setterA"), "status_changed", { from: "new", to: "not_in_target", outcome: "not_in_target", reason: "wrong_profile", note: "employee, no company" })
  const rjOld = await mkLead(teamA.id, "6", "Rejected Yesterday", "not_in_target", 60)
  await evt(rjOld, em("setterA"), "status_changed", { from: "new", to: "not_in_target", outcome: "not_in_target", reason: "wrong_profile", note: "old one" }, 40)
  const rjView = await mkLead(teamA.id, "7", "Rejected Via Viewas", "not_in_target", 10)
  await evt(rjView, "antonio@example.test", "status_changed", { from: "new", to: "not_in_target", outcome: "not_in_target", reason: "no_budget", via_view_as: true })
  const lB = await mkLead(teamB.id, "9", "Other Team Stale", "new", 100)
  await evt(lB, em("setterA"), "status_changed", { from: "new", to: "not_in_target", outcome: "not_in_target", reason: "x", note: "OTHER TEAM" })
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }, { key: "sold", label: "Sold" }]], ["sale_kind_stages", { strategic_call: "sold" }]] as const) {
    const r = await S.setMarketingSetting({ key: k, value: v, teamId: teamA.id, actor: "qa-td" }); if (r.ok === false) throw new Error(`setting ${k}: ${r.error}`)
  }

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






  const body = (page: import("playwright").Page) => page.locator("body").innerText().then(t => t.replace(/\s+/g, " "))
  const owner = await session(em("ownerA")), setter = await session(em("setterA")), admin = await session(em("admin"))

  let v = await view(owner, "/marketing/today")
  const sum = (await v.page.getByTestId("today-summary").innerText()).replace(/\s+/g, " ")
  ck("T1 the summary line counts what is waiting: 1 Good, 0 call backs, 2 untouched over a day (not the fresh one, not the other team's), 1 rejected today", /1 Good lead waiting for you/.test(sum) && /0 call backs today/.test(sum) && /2 new leads untouched for over a day/.test(sum) && /1 rejected today/.test(sum), sum)
  const stale = (await v.page.getByTestId("waiting-over-24h").innerText()).replace(/\s+/g, " ")
  ck("T2 'untouched over a day' lists Stale Two (waiting longest) before Stale One, and not Fresh Lead", stale.indexOf("Stale Two") !== -1 && stale.indexOf("Stale Two") < stale.indexOf("Stale One") && !/Fresh Lead/.test(stale) && !/Other Team/.test(stale), stale)
  const rejT = (await v.page.getByTestId("rejected-today").innerText()).replace(/\s+/g, " ")
  ck("T3 'Rejected today' shows the lead, who rejected it (a name), the reason and her note; not yesterday's, not the View-as one", /Rejected Today/.test(rejT) && /Qa Td Settera/.test(rejT) && /Wrong profile/.test(rejT) && /employee, no company/.test(rejT) && !/Yesterday/.test(rejT) && !/Via Viewas/.test(rejT) && !/OTHER TEAM/.test(rejT), rejT)
  ck("T4 the Good lead still shows the setter's note with a Pick button", /wants an LLC in Wyoming/.test(await body(v.page)) && (await v.page.getByRole("button", { name: /pick/i }).count()) >= 1)
  ck("T5 the team table is NOT on the main view (it is on the Team activity tab)", (await v.page.locator('section[aria-label="What the team did today"]').count()) === 0)
  await v.page.screenshot({ path: `${SHOTS}/qa-td-today.png`, fullPage: true }); await v.page.close()

  v = await view(owner, "/marketing/today?tab=team")
  const tbl = (await v.page.locator('section[aria-label="What the team did today"]').innerText()).replace(/\s+/g, " ")
  ck("T6 the Team activity tab shows people by name, not email, with their counts", /Qa Td Settera/.test(tbl) && !/@example\.test/.test(tbl), tbl)
  const link = v.page.getByRole("link", { name: "Qa Td Settera" })
  ck("T7 a name is a link to the Leads list filtered to that person", (await link.count()) === 1 && /\/marketing\/leads\?by=/.test((await link.getAttribute("href")) ?? ""))
  await v.page.screenshot({ path: `${SHOTS}/qa-td-team.png`, fullPage: true })
  await link.click(); await v.page.waitForURL(/by=/, { timeout: 60000 }); await v.page.waitForLoadState("networkidle")
  const filtered = await body(v.page)
  ck("T8 the filtered Leads list shows only what she worked on (Good Waiting A, Rejected Today ...), says whose, and not a lead she never touched", /Worked on by Qa Td Settera/.test(filtered) && /Good Waiting A/.test(filtered) && /Rejected Today/.test(filtered) && !/Fresh Lead/.test(filtered) && !/Stale One/.test(filtered) && !/Other Team Stale/.test(filtered), filtered.slice(0, 600))
  await v.page.getByRole("link", { name: "Show everyone" }).click(); await v.page.waitForURL(u => !u.search.includes("by="), { timeout: 60000 }); await v.page.waitForLoadState("networkidle")
  ck("T9 'Show everyone' removes the filter", /Fresh Lead/.test(await body(v.page)) && (await v.page.getByTestId("worked-by").count()) === 0); await v.page.close()

  v = await view(owner, `/marketing/leads?by=${encodeURIComponent("nobody@example.test")}`)
  ck("T10 a 'by' that is not a member of the team is ignored (full list, no filter badge)", (await v.page.getByTestId("worked-by").count()) === 0 && /Fresh Lead/.test(await body(v.page))); await v.page.close()
  v = await view(owner, `/marketing/leads?by=${encodeURIComponent(em("setterA"))}`)
  ck("T11 another team's work by the same person never shows in this team's filter", !/Other Team Stale/.test(await body(v.page))); await v.page.close()

  v = await view(setter, "/marketing/today")
  ck("T12 a setter is sent away from the owner's Today (to her Leads)", !/\/marketing\/today/.test(v.page.url()) && (await v.page.getByTestId("today-summary").count()) === 0, v.page.url()); await v.page.close()
  v = await view(admin, `/marketing/today?team=${teamA.id}`)
  ck("T13 Antonio without 'View as' does not get the team's Today", (await v.page.getByTestId("today-summary").count()) === 0, v.page.url()); await v.page.close()

  // more leads than the list shows: an old lead a person worked on must still be found through that person
  const old = await mkLead(teamA.id, "8", "Very Old Worked Lead", "contacted", 24 * 400)
  await evt(old, em("setterA"), "status_changed", { from: "new", to: "contacted", outcome: "call_back" }, 5)
  await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, status, ad_name, received_at, answers) select $1, 'qt-fill-' || g, 'Filler ' || g, 'contacted', 'Ad Alpha', now() - ((g % 50 + 1) || ' minutes')::interval, '[]'::jsonb from generate_series(1, 560) g", [teamA.id])
  v = await view(owner, "/marketing/leads")
  ck("T14 with more than 500 leads the plain list says it shows the newest 500", (await v.page.getByTestId("list-cut").count()) === 1 && !/Very Old Worked Lead/.test(await body(v.page))); await v.page.close()
  v = await view(owner, `/marketing/leads?by=${encodeURIComponent(em("setterA"))}`)
  ck("T15 but through the person it is found, however old (leads are read by id, not from the newest 500), and no 'cut' notice", /Very Old Worked Lead/.test(await body(v.page)) && (await v.page.getByTestId("list-cut").count()) === 0); await v.page.close()
  v = await view(owner, "/marketing/today")
  ck("T16 Today still counts the same with 560 more recent leads (they are being worked, not 'untouched over a day')", /2 new leads untouched for over a day/.test((await v.page.getByTestId("today-summary").innerText()).replace(/\s+/g, " "))); await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
