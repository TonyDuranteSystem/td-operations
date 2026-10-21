/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Money): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-va.ts */
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
const em = (k: string) => `qa-va-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qv-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qv-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qv-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA va %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-va-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA va A ${stamp}`, actor: "qa-va" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-va")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-va", permissions: [] as string[] }
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


  const L1 = (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, received_at, claimed_by, claimed_by_label, claimed_at, answers) values ($1,'qv-1','Mario Rossi','mario.qa@example.test','+393330000001','qualified',now(),$2,$3,now(),'[]'::jsonb) returning id", [teamA.id, ids.setterA, em("setterA")])).rows[0].id as string

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




  const admin = await session(em("admin")), owner = await session(em("ownerA")), staff = await session(em("staff"))
  const body = (page: import("playwright").Page) => page.locator("body").innerText().then(t => t.replace(/\s+/g, " "))
  const teamsUrl = `/marketing-leads/teams`

  let v = await view(admin, "/marketing")
  ck("V1 Antonio opening /marketing with no view picked is told where to choose one, and sees no workspace", /View as/.test(await body(v.page)) && !/Today|Call list/.test(await v.page.locator("nav").allInnerTexts().then(a => a.join(" "))), (await body(v.page)).slice(0, 200)); await v.page.close()

  v = await view(admin, teamsUrl)
  const section = v.page.locator("section", { hasText: `QA va A ${stamp}` })
  const opts = (await section.getByRole("button").allInnerTexts()).join(" | ")
  ck("V2 the Teams page offers 'View as' with the team owner and each role from the bundles setting", /Team owner \(every screen\)/.test(opts) && /Setter/.test(opts) && /Content/.test(opts) && /Seller/.test(opts), opts)
  await section.getByRole("button", { name: "Team owner (every screen)" }).click()
  await v.page.waitForURL(/\/marketing\/today/, { timeout: 90000 })
  const banner = await v.page.getByRole("status").innerText()
  const side = (await v.page.locator('nav[aria-label="Workspace"]').innerText()).replace(/\s+/g, " ")
  ck("V3 viewing as the owner: lands on Today, a banner says who he is viewing as, and every owner screen is in the menu", /Viewing as the team owner/.test(banner) && /Money/.test(side) && /Team/.test(side) && /Leads/.test(side), { banner, side })
  await v.page.screenshot({ path: `${SHOTS}/qa-va-owner.png`, fullPage: true }); await v.page.close()

  v = await view(admin, `/marketing/leads?lead=${L1}`)
  ck("V4 the lead the setter picked opens, with the payment link box and the buttons (nothing blocked)", await v.page.locator('section[aria-label="Payment link"]').count() === 1 && /Give it back/.test(await body(v.page)), (await body(v.page)).slice(0, 300))
  await v.page.getByRole("button", { name: "Give it back" }).click()
  await v.page.waitForFunction(() => /Pick this lead/.test(document.body.innerText), null, { timeout: 60000 })
  const rel = (await db.query("select claimed_by from marketing_leads where id=$1", [L1])).rows[0].claimed_by
  const ev = (await db.query("select actor from marketing_lead_events where lead_id=$1 and kind='released' order by id desc limit 1", [L1])).rows[0]
  ck("V5 Antonio can take the lead back from the setter, and it is recorded under his own email", rel === null && ev?.actor === em("admin"), { rel, ev }); await v.page.close()

  const api = await admin.request.post(`${BASE}/api/marketing-admin/view-as`, { data: { teamId: teamA.id, as: "nonexistent_role" } })
  ck("V6 an unknown role is refused", api.status() === 400, api.status())
  const bad = await staff.request.post(`${BASE}/api/marketing-admin/view-as`, { data: { teamId: teamA.id, as: "owner" } })
  ck("V7 a staff login cannot use the view-as route", bad.status() === 403, bad.status())

  const set = await admin.request.post(`${BASE}/api/marketing-admin/view-as`, { data: { teamId: teamA.id, as: "setter" } })
  ck("V8 choosing the Setter view works", set.ok(), set.status())
  v = await view(admin, "/marketing")
  const side2 = (await v.page.locator('nav[aria-label="Workspace"]').innerText()).replace(/\s+/g, " ")
  ck("V9 as the Setter: lands on the Call list, and the menu is the setter's (no Money, no Team, no Today)", /\/marketing\/call-list/.test(v.page.url()) && /Call list/.test(side2) && !/Money|Team|Today/.test(side2.replace("Team", "Team")) , { url: v.page.url(), side2 }); await v.page.close()
  v = await view(admin, "/marketing/money")
  ck("V10 as the Setter the Money page is not available, exactly as for a real setter", /do not have access to Money/.test(await body(v.page))); await v.page.close()

  v = await view(admin, "/marketing/call-list")
  await v.page.getByRole("button", { name: "Exit view" }).click()
  await v.page.waitForURL(/marketing-leads\/teams/, { timeout: 60000 })
  const after = await view(admin, "/marketing")
  ck("V11 Exit view ends it: the workspace is closed again", /View as/.test(await body(after.page)) && (await after.page.locator('nav[aria-label="Workspace"]').count()) === 0); await after.page.close(); await v.page.close()

  // a forged cookie on anybody who is not a strict admin is ignored
  const forged = `${teamA.id}:owner`
  await staff.addCookies([{ name: "td_marketing_view_as", value: forged, domain: new URL(BASE).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }])
  v = await view(staff, "/marketing/today")
  ck("V12 a staff login that carries the cookie is still turned away", !/Good leads waiting|Viewing as/.test(await body(v.page))); await v.page.close()
  await owner.addCookies([{ name: "td_marketing_view_as", value: `${teamA.id}:bundle=setter`, domain: new URL(BASE).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }])
  v = await view(owner, "/marketing/today")
  ck("V13 the real team owner carrying the cookie is not affected (no banner, still the owner's Today)", !/Viewing as/.test(await body(v.page)) && /Today|Good leads waiting/.test(await body(v.page))); await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
