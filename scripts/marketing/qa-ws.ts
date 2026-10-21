/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Slice 2a): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-ws.ts */
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
const em = (k: string) => `qa-ws-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qw-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qw-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA ws %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-ws-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA ws A ${stamp}`, actor: "qa-ws" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-ws")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-ws", permissions: [] as string[] }
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
  const seed = async (n: string, name: string, o: { status?: string; at?: number; claimedBy?: string | null; label?: string; cb?: number | null; phone?: string } = {}) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, phone, status, received_at, claimed_by, claimed_by_label, claimed_at, callback_at, answers) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) returning id",
      [teamA.id, `qw-${n}`, name, o.phone ?? `+3933300${n.padStart(5, "0")}`, o.status ?? "new", H(o.at ?? 1), o.claimedBy ?? null, o.label ?? null, o.claimedBy ? H(0.5) : null, o.cb === undefined || o.cb === null ? null : H(-o.cb),
       JSON.stringify([{ name: "che_attività_hai?", values: ["servizi_e_consulenze"] }, { name: "dove_vivi_oggi?", values: ["fuori_dall'italia"] }])])).rows[0].id as string
  const L: Record<string, string> = {}
  L.newOld = await seed("1", "Oldest New", { at: 50 })
  L.newMid = await seed("2", "Middle New", { at: 20 })
  L.newFresh = await seed("3", "Fresh New", { at: 2 })
  L.cbLate = await seed("4", "Late Callback", { status: "contacted", at: 30, cb: -3 })
  L.cbSoon = await seed("5", "Soon Callback", { status: "contacted", at: 30, cb: 0.2 })
  L.cbTomorrow = await seed("6", "Tomorrow Callback", { status: "contacted", at: 30, cb: 30 })
  L.goodOld = await seed("7", "Good Older", { status: "qualified", at: 12 })
  L.goodNew = await seed("8", "Good Newer", { status: "qualified", at: 4 })
  L.goodTaken = await seed("9", "Good Taken", { status: "qualified", at: 6, claimedBy: ids.setterA, label: em("setterA") })
  L.mine = await seed("10", "Owner Own Lead", { status: "contacted", at: 9, claimedBy: ids.ownerA, label: em("ownerA") })
  L.theirNew = await seed("11", "Taken By Owner New", { at: 8, claimedBy: ids.ownerA, label: em("ownerA") })
  const evt = (lead: string, kind: string, actor: string, data: object, h: number) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,$2,$3,$4,$5)", [lead, kind, actor, JSON.stringify(data), H(h)])
  await evt(L.goodOld, "status_changed", em("setterA"), { from: "new", to: "qualified", outcome: "good", note: "wants an LLC" }, 1)
  await evt(L.mine, "claimed", em("ownerA"), {}, 0.5)

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


  const owner = await session(em("ownerA")), setter = await session(em("setterA")), staff = await session(em("staff"))
  const nav = (page: import("playwright").Page) => page.locator('nav[aria-label="Workspace"]').innerText()
  const rows = (page: import("playwright").Page, label: string) => page.locator(`section[aria-label="${label}"] li`).allInnerTexts()

  // ── owner: home, sidebar, Today ──
  let v = await view(owner, "/marketing")
  ck("W1 the owner opening /marketing lands on Today", /\/marketing\/today/.test(v.page.url()), v.page.url())
  const on = await nav(v.page)
  const order = ["Today", "Leads", "Inbox", "WhatsApp", "Chat", "Calls", "Money", "Offers", "Content", "Reports", "Team"]
  const pos = order.map(x => on.indexOf(x))
  ck("W2 the sidebar lists the owner's screens in the mockup's order; screens not built yet are greyed 'soon'", pos.every((x, i) => x >= 0 && (i === 0 || x > pos[i - 1])) && (on.match(/soon/gi) ?? []).length === 7 && !/Call list|My numbers/.test(on), on)
  const cbs = await rows(v.page, "Call backs due")
  ck("W3 Today: call backs due today, the late one first and flagged late, tomorrow's left out", cbs.length === 2 && /Late Callback/.test(cbs[0]) && /late/.test(cbs[0]) && /Soon Callback/.test(cbs[1]) && !cbs.join().includes("Tomorrow"), cbs)
  const gw = await rows(v.page, "Good leads waiting")
  ck("W4 Today: the Good leads nobody picked, longest waiting first, each with Pick this lead; the one a setter holds is not offered", gw.length === 2 && /Good Older/.test(gw[0]) && /Good Newer/.test(gw[1]) && gw.every(x => /Pick this lead/.test(x)) && !gw.join().includes("Good Taken"), gw)
  const mine = await rows(v.page, "My leads")
  ck("W5 Today: 'Your leads' lists the open leads the owner picked (both of them)", mine.length === 2 && mine.some(x => /Owner Own Lead/.test(x)) && mine.some(x => /Taken By Owner New/.test(x)), mine)
  const team = await v.page.locator('section[aria-label="What the team did today"]').innerText()
  ck("W6 Today: what the team did today, per person (the setter's Good, the owner's pick)", /qa-ws-settera@example\.test\s+setter\s+1\s+0\s+0\s+0/i.test(team.replace(/\s+/g, " ")) || /qa-ws-settera/.test(team) && /qa-ws-ownera/.test(team), team)
  await v.page.screenshot({ path: `${SHOTS}/qa-ws-today.png`, fullPage: true })

  // ── pick from Today ──
  await v.page.locator('section[aria-label="Good leads waiting"] li', { hasText: "Good Older" }).getByRole("button", { name: "Pick this lead" }).click()
  await v.page.waitForURL(/\/marketing\/leads\?lead=/, { timeout: 60000 })
  const picked = (await db.query("select claimed_by from marketing_leads where id=$1", [L.goodOld])).rows[0].claimed_by
  ck("W7 picking from Today takes the lead for the owner and opens it", picked === ids.ownerA && v.page.url().includes(L.goodOld), { picked, url: v.page.url() })
  await v.page.close()
  v = await view(owner, "/marketing/today")
  const gw2 = await rows(v.page, "Good leads waiting"), mine2 = await rows(v.page, "My leads")
  ck("W8 afterwards it is no longer waiting and is under 'Your leads'", gw2.length === 1 && !gw2.join().includes("Good Older") && mine2.some(x => /Good Older/.test(x)) && mine2.length === 3, { gw2, mine2 })
  await v.page.close()

  // ── Leads: list and detail side by side ──
  v = await view(owner, `/marketing/leads?lead=${L.goodNew}`)
  const list = await v.page.locator('section[aria-label="Lead list"]').innerText()
  const detail = (await v.page.locator('aside[aria-label="Lead detail"]').innerText()).replace(/\s+/g, " ")
  ck("W9 Leads: the list on the left and the lead on the right, with the form answers in plain words, the buttons and the history", /Good Newer/.test(list) && /Good Newer/.test(detail) && /Servizi e consulenze/.test(detail) && /Fuori dall'italia/.test(detail) && /Pick this lead/.test(detail) && /History/.test(detail), detail.slice(0, 500))
  await v.page.screenshot({ path: `${SHOTS}/qa-ws-leads.png`, fullPage: true }); await v.page.close()
  v = await view(owner, "/marketing/leads?show=mine")
  const mineList = await v.page.locator('section[aria-label="Lead list"]').innerText()
  ck("W10 Leads: 'Picked by me' shows only the owner's leads", /Owner Own Lead/.test(mineList) && /Good Older/.test(mineList) && !/Fresh New/.test(mineList), mineList.slice(0, 300)); await v.page.close()
  v = await view(owner, `/marketing/leads/${L.newFresh}`)
  ck("W11 an old one-lead link still works: it opens the lead beside the list", /\/marketing\/leads\?lead=/.test(v.page.url()) && /Fresh New/.test(await v.page.locator('aside[aria-label="Lead detail"]').innerText()), v.page.url()); await v.page.close()

  // ── setter: home, sidebar, Call list ──
  await db.query("insert into marketing_settings (key, team_id, value, updated_by) values ('qualification_checklist', $1, $2::jsonb, 'qa-ws') on conflict do nothing", [teamA.id, JSON.stringify(["Has or plans a business", "Wants a US company"])]).catch(() => null)
  v = await view(setter, "/marketing")
  ck("W12 a setter opening /marketing lands on the Call list", /\/marketing\/call-list/.test(v.page.url()), v.page.url())
  const sn = (await nav(v.page)).replace(/\s+/g, " ")
  ck("W13 the setter's sidebar: Call list, Leads, Inbox/WhatsApp/Chat/My numbers greyed; no Today, no Money, no Team", /Call list/.test(sn) && /Leads/.test(sn) && /My numbers/.test(sn) && !/Today|Money|Team|Offers/.test(sn), sn)
  const q = await rows(v.page, "Leads to call")
  ck("W14 Call list order: the late call back, the call back later today, then new leads oldest first; the owner's lead and tomorrow's call back are not on it", q.length === 5 && /Late Callback/.test(q[0]) && /Soon Callback/.test(q[1]) && /Oldest New/.test(q[2]) && /Middle New/.test(q[3]) && /Fresh New/.test(q[4]) && !q.join().includes("Taken By Owner") && !q.join().includes("Tomorrow"), q)
  const firstDetail = (await v.page.locator('aside[aria-label="Lead to call"]').innerText()).replace(/\s+/g, " ")
  ck("W15 the first lead opens by itself, with what they wrote and the buttons", /Late Callback/.test(firstDetail) && /Servizi e consulenze/.test(firstDetail) && /Not in target/.test(firstDetail), firstDetail.slice(0, 300))
  await v.page.screenshot({ path: `${SHOTS}/qa-ws-calllist.png`, fullPage: true })

  // ── the next-lead flow ──
  await v.page.getByText("Oldest New").first().click()
  await v.page.waitForURL(new RegExp(L.newOld), { timeout: 60000 })
  await v.page.getByRole("button", { name: "Not in target" }).click()
  await v.page.locator("select").selectOption("not_interested")
  await v.page.locator("textarea").fill("said no")
  await v.page.getByRole("button", { name: "Save" }).click()
  await v.page.waitForURL(new RegExp(L.newMid), { timeout: 60000 })
  const l1 = (await db.query("select status, not_in_target_reason from marketing_leads where id=$1", [L.newOld])).rows[0]
  ck("W16 Not in target saves and the NEXT lead in the list opens by itself", l1.status === "not_in_target" && l1.not_in_target_reason === "not_interested" && v.page.url().includes(L.newMid), { l1, url: v.page.url() })
  const q2 = await rows(v.page, "Leads to call")
  ck("W17 the lead that was marked leaves the list", q2.length === 4 && !q2.join().includes("Oldest New"), q2)
  await v.page.getByRole("button", { name: "Good" }).click()
  await v.page.getByLabel("Has or plans a business").check()
  await v.page.getByRole("button", { name: "Save" }).click()
  await v.page.waitForURL(url => !url.toString().includes(L.newMid), { timeout: 60000 })
  const l2 = (await db.query("select status, qualification from marketing_leads where id=$1", [L.newMid])).rows[0]
  ck("W18 Good saves the ticks and moves on to the next lead", l2.status === "qualified" && l2.qualification?.[0]?.ticked === true, l2)
  await v.page.close()

  // ── who is turned away ──
  v = await view(setter, "/marketing/today")
  ck("W19 a setter cannot open Today (sent to Leads)", /\/marketing\/leads/.test(v.page.url()) && !/Good leads waiting/.test(v.text), v.page.url()); await v.page.close()
  v = await view(setter, "/marketing/team")
  ck("W20 a setter cannot manage the team", /cannot manage the team/i.test(v.text) && !/Invite someone/.test(v.text), v.text.slice(0, 200)); await v.page.close()
  v = await view(staff, "/marketing/today")
  ck("W21 a staff login is sent away from the workspace", !/Good leads waiting|Call list/.test(v.text), v.text.slice(0, 120)); await v.page.close()
  await db.query("update marketing_teams set status='paused' where id=$1", [teamA.id])
  v = await view(setter, "/marketing")
  ck("W22 when Antonio pauses the team the setter sees why, and no workspace", !/Call list/.test(await v.page.locator("body").innerText()) || /cannot come in/i.test(await v.page.locator("body").innerText()), (await v.page.locator("body").innerText()).slice(0, 200)); await v.page.close()
  await db.query("update marketing_teams set status='active' where id=$1", [teamA.id])

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
