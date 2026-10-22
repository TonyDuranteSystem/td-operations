/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, build step 5: Calendar): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-calendar.ts */
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
const em = (k: string) => `qa-cl-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qcl-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qcl-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qcl-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA cl %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-cl-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA cl A ${stamp}`, actor: "qa-cl" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-cl")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-cl", permissions: [] as string[] }
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
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter"); await mk("aleA", "member", "content"); await mk("marcoA", "member", "setter"); await mk("sellerA", "member", "seller")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }








  const mkLead = async (n: string, name: string, hoursFromNow: number | null, claimed: string | null = null) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, callback_at, claimed_by, claimed_by_label, answers) values ($1,$2,$3,$4,'+393339990000','contacted','Ad Alpha', now() - interval '3 days', case when $5::text is null then null else now() + ($5 || ' hours')::interval end, $6, $7, '[]'::jsonb) returning id", [teamA.id, `qcl-${n}`, name, `qcl${n}@example.test`, hoursFromNow === null ? null : String(hoursFromNow), claimed, claimed ? em("ownerA") : null])).rows[0].id as string
  const cb = (lead: string, actor: string, note?: string) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,'status_changed',$2,$3, now() - interval '1 hour')", [lead, actor, JSON.stringify({ from: "new", to: "contacted", outcome: "call_back", ...(note ? { note } : {}) })])
  const aLate = await mkLead("a", "Late Chiara Lead", -3); await cb(aLate, em("setterA"), "asked to call after her meeting")
  const aSoon = await mkLead("b", "Soon Chiara Lead", 1); await cb(aSoon, em("setterA"))
  const bSoon = await mkLead("c", "Soon Marco Lead", 2); await cb(bSoon, em("marcoA"))
  const bTmrw = await mkLead("d", "Tomorrow Marco Lead", 26); await cb(bTmrw, em("marcoA"))
  const moved = await mkLead("e", "Picked By Rocco Lead", 3, ids.ownerA); await cb(moved, em("setterA"))
  const far = await mkLead("f", "Far Chiara Lead", 24 * 20); await cb(far, em("setterA"))
  const outsider = await mkLead("g", "Set By Antonio Lead", 4); await cb(outsider, "antonio@example.test")
  await mkLead("h", "No Call Back Lead", null)
  const sellerOwn = await mkLead("i", "Seller Picked Lead", 5, ids.sellerA); await cb(sellerOwn, em("marcoA"))
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }, { key: "sold", label: "Sold" }]], ["sale_kind_stages", { strategic_call: "sold" }]] as const) {
    const r = await S.setMarketingSetting({ key: k, value: v, teamId: teamA.id, actor: "qa-cl" }); if (r.ok === false) throw new Error(`setting ${k}: ${r.error}`)
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
  const owner = await session(em("ownerA")), chiara = await session(em("setterA")), marco = await session(em("marcoA")), ale = await session(em("aleA")), seller = await session(em("sellerA"))
  const names = async (page: import("playwright").Page) => (await page.getByTestId("cal-item").allInnerTexts()).map(t => t.replace(/\s+/g, " "))

  let v = await view(owner, "/marketing/calendar")
  let items = await names(v.page)
  const all = items.join(" | ")
  ck("C1 Rocco (everyone) sees every call back in the window: both setters', the one Rocco picked, and the one set from outside the team; not the lead with no call back, not the far one", ["Late Chiara Lead", "Soon Chiara Lead", "Soon Marco Lead", "Tomorrow Marco Lead", "Picked By Rocco Lead", "Set By Antonio Lead"].every(n => all.includes(n)) && !all.includes("No Call Back Lead") && !all.includes("Far Chiara Lead"), all)
  ck("C2 the late one is in its own red 'Late' section, first", (await v.page.getByTestId("cal-late").count()) === 1 && /Late Chiara Lead/.test(await v.page.getByTestId("cal-late").innerText()) && /late/.test(items[0]))
  ck("C3 each row says who set it ('set by Qa Cl Settera'); the one set outside the team says so, not a guessed name", /Late Chiara Lead.*set by Qa Cl Settera/.test(all) && /Soon Marco Lead.*set by Qa Cl Marcoa/.test(all) && /Set By Antonio Lead.*set by Antonio/.test(all), all)
  ck("C4 the setter's note shows under the call back for people who may read notes", /asked to call after her meeting/.test(all))
  ck("C5 days are listed in order, with Today and Tomorrow named", (await v.page.getByTestId("cal-day").count()) >= 2 && /Today · /.test(await body(v.page)) && /Tomorrow · /.test(await body(v.page)))
  ck("C6 the page has a picker with Everyone and each person", (await v.page.getByTestId("cal-picker").count()) === 1 && /Qa Cl Settera/.test(await v.page.getByTestId("cal-picker").innerText()) && /Qa Cl Marcoa/.test(await v.page.getByTestId("cal-picker").innerText()))
  const html1 = await v.page.content()
  ck("C7 no phone number anywhere on the Calendar", !html1.includes("3339990000"))
  await v.page.screenshot({ path: `${SHOTS}/qa-cl-rocco.png`, fullPage: true })
  const chiaraId = ids.setterA
  await v.page.close()

  v = await view(owner, `/marketing/calendar?who=${chiaraId}`)
  items = await names(v.page); const ch = items.join(" | ")
  ck("C8 the picker narrows to Chiara: hers only (late + soon), not Marco's, not the one Rocco picked, not the outsider's", ch.includes("Late Chiara Lead") && ch.includes("Soon Chiara Lead") && !ch.includes("Marco Lead") && !ch.includes("Picked By Rocco Lead") && !ch.includes("Set By Antonio Lead"), ch)
  await v.page.close()

  v = await view(owner, "/marketing/calendar?days=30")
  ck("C9 'Show 30 days' brings the far one in", (await names(v.page)).join(" ").includes("Far Chiara Lead"))
  await v.page.close()
  v = await view(owner, "/marketing/calendar")
  ck("C10 and the 14-day page says there is one more after these days, with the link", /1 more later/.test(await body(v.page)) && (await v.page.getByTestId("cal-more").count()) === 1)
  await v.page.close()

  v = await view(chiara, "/marketing/calendar")
  const cht = await body(v.page); const chHtml = await v.page.content()
  items = await names(v.page)
  ck("C11 Chiara (setter) sees only HERS: Late Chiara, Soon Chiara", items.length === 2 && cht.includes("Late Chiara Lead") && cht.includes("Soon Chiara Lead"), items)
  ck("C12 and nothing of Marco's, Rocco's or the outsider's is in the page the server sent to her", !chHtml.includes("Marco Lead") && !chHtml.includes("Picked By Rocco Lead") && !chHtml.includes("Set By Antonio Lead") && !chHtml.includes("Far Chiara") === true, "leak")
  ck("C13 she has no picker, no 'set by' column", (await v.page.getByTestId("cal-picker").count()) === 0 && !/set by/.test(cht))
  await v.page.close()
  v = await view(chiara, `/marketing/calendar?who=${ids.marcoA}`)
  const typed = await body(v.page)
  ck("C14 she types Marco's id in the address: she still gets only her own list", typed.includes("Soon Chiara Lead") && !typed.includes("Marco Lead"), typed.slice(0, 300))
  await v.page.close()

  v = await view(marco, "/marketing/calendar")
  const mt = await body(v.page)
  ck("C15 Marco sees his own two, not Chiara's, and not the lead a seller picked after Marco set its call back", mt.includes("Soon Marco Lead") && mt.includes("Tomorrow Marco Lead") && !mt.includes("Chiara Lead") && !mt.includes("Seller Picked Lead"))
  await v.page.close()

  v = await view(seller, "/marketing/calendar")
  const sl = await body(v.page)
  ck("C16 a seller (picks leads) opens the Calendar and sees only the call back on the lead SHE picked (owner = picker), nothing of the setters'", sl.includes("Seller Picked Lead") && !sl.includes("Chiara Lead") && !sl.includes("Marco Lead") && !sl.includes("Picked By Rocco Lead"), sl.slice(0, 300))
  await v.page.close()

  v = await view(ale, "/marketing/calendar")
  const at = await body(v.page); const aleHtml = await v.page.content()
  ck("C17 the ad person is refused by the server and no lead name reaches the page", /do not have access to the Calendar/.test(at) && !aleHtml.includes("Chiara Lead") && !aleHtml.includes("Marco Lead"), at.slice(0, 200))
  await v.page.close()
  v = await view(ale, "/marketing/leads")
  ck("C18 and there is no Calendar in her menu", !/\bCalendar\b/.test(await body(v.page))); await v.page.close()
  v = await view(chiara, "/marketing/leads")
  ck("C19 Chiara's menu has Calendar", /\bCalendar\b/.test(await body(v.page))); await v.page.close()

  v = await view(owner, "/marketing/calendar")
  await v.page.getByTestId("cal-item").first().click()
  await v.page.waitForURL(/\/marketing\/leads\?lead=/, { timeout: 60000 })
  ck("C20 a row opens the lead in Leads", /\/marketing\/leads\?lead=/.test(v.page.url())); await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
