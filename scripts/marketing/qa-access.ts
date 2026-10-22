/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, access popup): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-access.ts */
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
const em = (k: string) => `qa-ac-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qac-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qac-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qac-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA ac %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-ac-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA ac A ${stamp}`, actor: "qa-ac" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-ac")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-ac", permissions: [] as string[] }
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






  const mkLead = async (n: string, name: string, status: string) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, answers) values ($1,$2,$3,$4,'+393339990000',$5,'Ad Alpha', now() - interval '3 hours', $6::jsonb) returning id", [teamA.id, `qac-${n}`, name, `qac${n}@example.test`, status, JSON.stringify([{ name: "phone_number", values: ["+393339990000"] }, { name: "city", values: ["Milan"] }])])).rows[0].id as string
  const evt = (lead: string, actor: string, kind: string, data: object) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,$2,$3,$4, now() - interval '20 minutes')", [lead, kind, actor, JSON.stringify(data)])
  const l1 = await mkLead("1", "Wyoming Lead", "qualified")
  await evt(l1, em("setterA"), "status_changed", { from: "new", to: "qualified", outcome: "good", note: "wants an LLC in Wyoming" })
  await mkLead("2", "Fresh Person", "new")
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }, { key: "sold", label: "Sold" }]], ["sale_kind_stages", { strategic_call: "sold" }]] as const) {
    const r = await S.setMarketingSetting({ key: k, value: v, teamId: teamA.id, actor: "qa-ac" }); if (r.ok === false) throw new Error(`setting ${k}: ${r.error}`)
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
  const owner = await session(em("ownerA")), setter = await session(em("setterA"))

  // ── Rocco invites Ale with the popup: Ad person + Analyst ──
  let v = await view(owner, "/marketing/team")
  const rocco = v.page
  ck("A1 the Team page has an 'Invite someone' button and no old role drop-down", (await rocco.getByTestId("open-invite").count()) === 1 && (await rocco.locator("select").count()) === 0)
  ck("A2 Rocco's own row has no gear, the setter's row has one", (await rocco.getByTestId("change-access").count()) === 1)
  await rocco.getByTestId("open-invite").click()
  await rocco.getByTestId("access-popup").waitFor({ timeout: 60000 })
  const emailIn = rocco.getByLabel("Their email"); await emailIn.fill(em("aleA"))
  const sub = rocco.getByTestId("access-submit")
  ck("A3 the popup starts with no role and says so; the button names the outcome", /custom access/.test(await sub.innerText()) && (await rocco.getByTestId("access-state").innerText()).includes("no changes"))
  await rocco.locator('[data-role="content"]').click(); await rocco.locator('[data-role="analyst"]').click()
  const st = (await rocco.getByTestId("access-state").innerText()).replace(/\s+/g, " ")
  ck("A4 two roles together: 'Ad person + Analyst (read only)', no changes", /Ad person \+ Analyst \(read only\)/.test(st) && /no changes/.test(st), st)
  const on = async (k: string) => (await rocco.locator(`[data-menu="${k}"]`).getAttribute("data-on")) === "1"
  ck("A5 the live menu: Leads, Team activity and Reports on; Today, Call list, Money off; opens on Leads", (await on("leads")) && (await on("activity")) && (await on("reports")) && !(await on("today")) && !(await on("call-list")) && !(await on("money")) && /Opens on: Leads/.test(await rocco.getByTestId("opens-on").innerText()))
  ck("A6 the plain line says what Ale will not do (no phone numbers, no payment links)", /Will not:.*see phone numbers and call leads/.test(await rocco.getByTestId("wont").innerText()))
  await rocco.locator('[data-perm="leads.pick"]').scrollIntoViewIfNeeded()
  await rocco.locator('details summary', { hasText: "Leads" }).first().click().catch(() => {})
  await rocco.locator('[data-perm="payment_links.create"]').evaluate(el => (el.closest("details") as HTMLDetailsElement).open = true)
  await rocco.locator('[data-perm="payment_links.create"]').check()
  const warn = (await rocco.getByTestId("access-warning").first().innerText()).replace(/\s+/g, " ")
  ck("A7 an odd combination warns with a one-click fix (payment links without Money)", /cannot see the Money pages/.test(warn), warn)
  await rocco.getByTestId("access-warning").first().getByRole("button", { name: /Also give the Money pages/ }).click()
  ck("A8 the fix ticks it and the warning goes", (await rocco.locator('[data-perm="money.read"]').isChecked()) && (await rocco.getByTestId("access-warning").count()) === 0)
  await rocco.locator('[data-perm="payment_links.create"]').uncheck(); await rocco.locator('[data-perm="money.read"]').uncheck()
  const st2 = (await rocco.getByTestId("access-state").innerText()).replace(/\s+/g, " ")
  ck("A9 after un-ticking, the state is back to 'no changes'", /no changes/.test(st2), st2)
  await sub.click()
  const linkBox = rocco.locator('[aria-label="Invitation link"] input')
  await linkBox.waitFor({ timeout: 60000 })
  const url = await linkBox.inputValue()
  const inv = (await db.query("select bundle, permissions from marketing_invites where email_lower=$1 and used_at is null and revoked_at is null", [em("aleA")])).rows[0]
  ck("A10 the invitation stores no role and the exact ticks (reports, notes, activity, leads)", inv && inv.bundle === null && ["leads.read", "reports.read", "team.activity", "team.notes"].every((p: string) => inv.permissions.includes(p)) && !inv.permissions.includes("leads.call"), inv)
  await rocco.close()

  // Ale accepts and signs in
  const acc = await M.acceptInvite({ token: new URL(url).searchParams.get("token") ?? "", password: PASS })
  if (acc.ok === false) throw new Error("accept ale: " + acc.error)
  ids.aleA = (await db.query("select id from auth.users where email=$1", [em("aleA")])).rows[0].id
  await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`, [ids.aleA])
  const ale = await session(em("aleA"))

  v = await view(ale, "/marketing")
  const nav = (await body(v.page))
  ck("A11 Ale lands on Leads and her menu shows Leads, Team activity, Reports (no Today, no Call list, no Money)", /\/marketing\/leads/.test(v.page.url()) && /Team activity/.test(nav) && /Reports/.test(nav) && !/\bToday\b/.test(nav) && !/Call list/.test(nav) && !/Money/.test(nav), v.page.url() + " " + nav.slice(0, 200))
  await v.page.close()
  v = await view(ale, `/marketing/leads?lead=${l1}`)
  const aleLead = await body(v.page)
  const aleHtml = await v.page.content()
  ck("A12 Ale reads the setter's note (she was given 'see other people's notes')", /wants an LLC in Wyoming/.test(aleLead), aleLead.slice(0, 300))
  ck("A13 Ale sees NO phone number anywhere in the page the server sent (not in the list, the card or the form answers)", !aleHtml.includes("3339990000") && !/Phone:/.test(aleLead) && /Milan/.test(aleLead), aleLead.slice(0, 300))
  await v.page.close()
  v = await view(ale, "/marketing/activity")
  const tbl = (await v.page.locator('section[aria-label="What the team did today"]').innerText()).replace(/\s+/g, " ")
  ck("A14 Ale opens Team activity and sees people by name (not email) in the table", /Qa Ac Settera/.test(tbl) && !/@example\.test/.test(tbl), tbl)
  await v.page.close()
  v = await view(ale, "/marketing/today")
  ck("A15 Today is not hers: she is sent to Leads", /\/marketing\/leads/.test(v.page.url()), v.page.url()); await v.page.close()
  v = await view(ale, "/marketing/team")
  ck("A16 she cannot open the Team page", /cannot manage the team/i.test(await body(v.page))); await v.page.close()
  const inviteTry = await ale.request.post(`${BASE}/api/marketing/team/members`, { data: { email: "x@example.test", permissions: ["leads.read"] } })
  ck("A17 she cannot invite anyone through the server either (403)", inviteTry.status() === 403, inviteTry.status())

  // ── the gear on the setter: remove 'see phone numbers' ──
  v = await view(owner, "/marketing/team")
  const row = v.page.locator("li", { hasText: em("setterA") })
  await row.getByTestId("change-access").click()
  await v.page.getByTestId("access-popup").waitFor({ timeout: 60000 })
  const sst = (await v.page.getByTestId("access-state").innerText()).replace(/\s+/g, " ")
  ck("A18 the gear opens with the setter's current access: role Setter pressed, no changes", /Setter/.test(sst) && /no changes/.test(sst) && (await v.page.locator('[data-role="setter"]').getAttribute("aria-pressed")) === "true", sst)
  await v.page.locator('[data-perm="leads.call"]').evaluate(el => (el.closest("details") as HTMLDetailsElement).open = true)
  await v.page.locator('[data-perm="leads.call"]').uncheck()
  const sst2 = (await v.page.getByTestId("access-state").innerText()).replace(/\s+/g, " ")
  ck("A19 removing one thing shows '1 change: without see phone numbers…'", /1 change/.test(sst2) && /without see phone numbers/.test(sst2), sst2)
  await v.page.getByTestId("access-submit").click()
  await v.page.getByText(/Access saved/).waitFor({ timeout: 60000 })
  const saved = (await db.query("select bundle, permissions from marketing_team_members where user_id=$1", [ids.setterA])).rows[0]
  ck("A20 saved as the exact list without that one thing, and no role", saved.bundle === null && !saved.permissions.includes("leads.call") && saved.permissions.includes("leads.mark"), saved)
  await v.page.close()
  v = await view(setter, `/marketing/call-list?lead=${l1}`)
  const sh = await v.page.content()
  ck("A21 the setter immediately has no phone number in the page (next click), but keeps the Call list", !sh.includes("3339990000") && /Call list/.test(await body(v.page)), (await body(v.page)).slice(0, 200)); await v.page.close()

  // ── removing access while someone is signed in ──
  await db.query("update marketing_team_members set permissions = array_remove(permissions, 'team.activity') where user_id=$1", [ids.aleA])
  v = await view(ale, "/marketing/activity")
  ck("A22 when access is taken away she gets a plain message, not a broken page", /do not have access to Team activity/i.test(await body(v.page)), (await body(v.page)).slice(0, 200)); await v.page.close()

  // ── setter + seller: both screens ──
  v = await view(owner, "/marketing/team")
  const row2 = v.page.locator("li", { hasText: em("setterA") })
  await row2.getByTestId("change-access").click()
  await v.page.getByTestId("access-popup").waitFor({ timeout: 60000 })
  await v.page.locator('[data-role="seller"]').click()
  const both = (await v.page.getByTestId("access-state").innerText()).replace(/\s+/g, " ")
  const bOn = async (k: string) => (await v.page.locator(`[data-menu="${k}"]`).getAttribute("data-on")) === "1"
  ck("A23 Setter + Seller: Today AND Call list AND My numbers are all on; opens on Today with the call list one click away", /Setter \+ Seller/.test(both) && (await bOn("today")) && (await bOn("call-list")) && (await bOn("my-numbers")) && /Opens on: Today \(the Call list is one click away\)/.test(await v.page.getByTestId("opens-on").innerText()), both)
  await v.page.screenshot({ path: `${SHOTS}/qa-ac-popup.png`, fullPage: true })
  await v.page.close()
  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
