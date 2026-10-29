/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa; Antonio, 29 Oct 2026: "why the setter has Novità and Documenti?" and "I click View as Setter, go back to my dashboard, click on Messages and I see the setter's messages").
   Through the REAL login, the REAL dev server and the REAL database, with a SETTER chat sitting on Antonio's Home page (the case the first tests never had):
   1. his CRM Home "Messages" panel and his menu number carry only the owners chat, never the Rocco-setter chat;
   2. "View as Setter" still works while he stays in the team's screens, and ends by itself the moment he opens his own Marketing section; his Messages then opens as himself (owner frame, no bar, no setter text);
   3. the setter has What's New but no Documents (menu and address).
   Needs: the private stack up (with migration 20261029-2100) and `td-marketing-dev` on :3010. Run: npx tsx scripts/marketing/qa-owner-fixes.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext, type Page } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const stamp = Date.now()
const em = (k: string) => `qa-of-${k.toLowerCase()}@example.test`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  type AuthAdmin = { auth: { admin: { listUsers: (a: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown>; createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>; updateUserById: (id: string, a: object) => Promise<unknown> } } }
  const A = (supabaseAdmin as unknown as AuthAdmin).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")

  // clean an earlier run (local test database only)
  await db.query("set session_replication_role = replica")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA of %'")).rows.map(x => x.id)
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qof-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qof-%'")
  if (oldTeams.length) {
    await db.query("delete from marketing_team_messages where team_id = any($1)", [oldTeams])
    await db.query("delete from marketing_chat_thread_members where thread_id in (select id from marketing_chat_threads where team_id = any($1))", [oldTeams])
    await db.query("delete from marketing_chat_threads where team_id = any($1)", [oldTeams])
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-of-"))) await A.deleteUser(u.id)
  await db.query("insert into storage.buckets (id, name, public) values ('onboarding-uploads', 'onboarding-uploads', false) on conflict do nothing")

  const teamA = (await S.createTeam({ name: `QA of A ${stamp}`, actor: "qa-of" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-of")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-of", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  const ids: Record<string, string> = {}
  const mk = async (key: string, role: "owner" | "member", bundle?: string) => {
    const inv = await M.createInvite({ teamId: teamA.id, email: em(key), memberRole: role, bundle: bundle ?? null, actor: adminActor })
    if (inv.ok === false) throw new Error(`invite ${key}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS })
    if (acc.ok === false) throw new Error(`accept ${key}: ${acc.error}`)
    ids[key] = (await db.query("select id from auth.users where email=$1", [em(key)])).rows[0].id
    await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'x')`, [ids[key]])
  }
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter")
  {
    const r = await A.createUser({ email: em("admin"), password: PASS, email_confirm: true, app_metadata: { role: "admin" }, user_metadata: { name: "Antonio Durante" } })
    if (r.error || !r.data.user) throw new Error(`seed admin: ${r.error?.message}`)
    ids.admin = r.data.user.id
    await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'x')`, [ids.admin])
  }
  for (const uid of Object.values(ids)) for (const k of ["setter", "seller", "content", "analyst", "owner"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) values ($1,$2,$3,'done') on conflict do nothing", [uid, teamA.id, k])
  const L = (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, answers) values ($1,$2,'Home Panel Lead','home@example.test','+393339990000','new','Ad Alpha', now() - interval '2 hours', null, null, '[]'::jsonb) returning id", [teamA.id, `qof-home-${stamp}`])).rows[0].id as string

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
  async function session(email: string, lang = "en"): Promise<BrowserContext> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 })
    await page.waitForTimeout(2500)
    await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', PASS); await page.click('button[type="submit"]')
    const until = Date.now() + 120000
    for (;;) { if ((await ctx.cookies(BASE)).some(c => /^sb-.*-auth-token/.test(c.name)) || Date.now() > until) break; await page.waitForTimeout(500) }
    await page.waitForTimeout(1500)
    await liftToAal2(ctx)
    await ctx.addCookies([{ name: "tdm_lang", value: lang, domain: new URL(BASE).hostname, path: "/" }])
    await page.close()
    return ctx
  }
  await A.updateUserById(ids.ownerA, { user_metadata: { full_name: "Rocco" } }); await A.updateUserById(ids.setterA, { user_metadata: { full_name: "Cristina" } })

  const adminCtx = await session(em("admin")), rocco = await session(em("ownerA")), setter = await session(em("setterA"))
  const open = async (ctx: BrowserContext, path: string) => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "load", timeout: 180000 }); await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); return p }
  const callOnce = (p: Page, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) } }, [method, path, payload ?? null] as const)
  const call = async (p: Page, method: string, path: string, payload?: object) => { for (let i = 0; ; i++) { try { return await callOnce(p, method, path, payload) } catch (e) { if (i >= 4 || !/context was destroyed|navigation/i.test(String(e))) throw e; await p.waitForTimeout(2500) } } }
  const text = async (p: Page) => (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, " ")

  // Antonio joins the team as a member (the Teams page button does the same); he stays an admin login
  const ap = await open(adminCtx, "/marketing-leads")
  ck("F0 Antonio joined the team", (await call(ap, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})).status === 200)
  const rp = await open(rocco, "/marketing"), sp = await open(setter, "/marketing")
  const send = (p: Page, lane: string, message: string) => call(p, "POST", `/api/marketing/chat/${L}/messages?lane=${lane}`, { message })
  const w = [await send(rp, "owners", "OWNERS-ONE ci vediamo lunedi"), await send(rp, "setter", "SETTERCHAT-FROM-ROCCO ho chiamato il lead"), await send(sp, "setter", "SETTERCHAT-FROM-CRISTINA sto richiamando")]
  ck("F1 the three messages are in place: one in the owners chat, two in the setter chat", w.every(x => x.status === 200), w.map(x => x.status))

  // ---- 1. his Home and his menu number
  const home = await open(adminCtx, "/marketing-leads")
  await home.waitForTimeout(2500)
  const homeText = await text(home)
  ck("F2 his Home 'Messages' panel shows the owners chat", /OWNERS-ONE/.test(homeText), homeText.slice(0, 400))
  ck("F3 his Home never shows a word of the Rocco-setter chat", !/SETTERCHAT/.test(homeText), homeText.match(/.{40}SETTERCHAT.{40}/)?.[0])
  const badge = await call(home, "GET", "/api/dashboard/badges")
  ck("F4 his menu number counts only the owners chat (1 unread), not the two setter-chat messages", badge.body?.marketing === 1, badge.body)
  const navBadge = await home.getByTestId("owner-nav-messages-badge").innerText().catch(() => null)
  ck("F5 the red number on Messages in his Marketing menu says 1", navBadge === "1", navBadge)

  // ---- 2. View as: works inside the team's screens, ends by itself in his own section
  const vp = await call(ap, "POST", "/api/marketing-admin/view-as", { teamId: teamA.id, as: "setter" })
  ck("F6 View as Setter is switched on", vp.status === 200, vp)
  const viewed = await open(adminCtx, "/marketing/chat")
  const vText = await text(viewed)
  ck("F7 inside the team's screens he is 'Viewing as' the setter, in the team's frame (no owner menu)", /Viewing as/.test(vText) && (await viewed.getByTestId("owner-nav").count()) === 0, vText.slice(0, 200))
  const cookieOn = async () => (await adminCtx.cookies(BASE)).some(c => c.name === "td_marketing_view_as" && c.value !== "")
  ck("F8 the View-as cookie is on while he stays in the team's screens", await cookieOn())
  const dash = await open(adminCtx, "/marketing-leads")
  for (let i = 0; i < 20 && (await cookieOn()); i++) await dash.waitForTimeout(500)
  ck("F9 the moment he opens his own Marketing section, View as is off", !(await cookieOn()))
  await dash.getByTestId("owner-nav-messages").click()
  await dash.waitForURL(/\/marketing\/chat/, { timeout: 120000 }).catch(() => undefined)
  await dash.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined)
  await dash.waitForTimeout(2500)
  const mText = await text(dash)
  ck("F10 clicking Messages in his menu now opens HIS Messages: his own frame, no 'Viewing as' bar", /\/marketing\/chat/.test(dash.url()) && !/Viewing as/.test(mText) && (await dash.getByTestId("owner-nav").count()) === 1, { url: dash.url(), head: mText.slice(0, 160) })
  ck("F11 and not a word of the setter chat is on that page", !/SETTERCHAT/.test(mText), mText.match(/.{40}SETTERCHAT.{40}/)?.[0])
  const apiNow = await call(dash, "GET", `/api/marketing/chat/${L}?lane=setter&mark_read=0`)
  ck("F12 the setter chat is still refused to him by address", apiNow.status === 403, apiNow.status)

  // ---- 3. the setter: What's New yes, Documents no
  const sh = await open(setter, "/marketing/news")
  ck("F13 the setter's menu has What's New", (await sh.getByTestId("nav-news").count()) === 1)
  ck("F14 the setter's menu has no Documents", (await sh.getByTestId("nav-documents").count()) === 0)
  const docs = await call(sp, "GET", "/api/marketing/documents")
  ck("F15 the setter is refused the Documents list by address", docs.status === 403, docs)
  const rh = await open(rocco, "/marketing/documents")
  ck("F16 Rocco still has Documents", (await rh.getByTestId("nav-documents").count()) === 1)

  await browser.close(); await db.end()
  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
