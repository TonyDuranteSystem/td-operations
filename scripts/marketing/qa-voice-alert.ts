/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa; Antonio, 29 Oct 2026: "I want to go back to my dashboard and not to the CRM" and "notification with sound for new messages, the sound must say Message from Rocco").
   Through the REAL login, the REAL dev server and the REAL database. The browser's voice is replaced by a recorder (a headless browser has no speakers): the test proves WHEN the page asks to say WHAT.
   Needs: the private stack up (with migration 20261029-2100) and `td-marketing-dev` on :3010. Run: npx tsx scripts/marketing/qa-voice-alert.ts [screenshot folder] */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext, type Page } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"
import { mkdirSync } from "node:fs"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const OUT = process.argv[2] ?? "/tmp/qa-voice"
const stamp = Date.now()
const em = (k: string) => `qa-vo-${k.toLowerCase()}@example.test`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

// replaces the browser's voice: what the page asks to say is kept in this browser's storage (shared by its tabs, like the real thing)
const RECORDER = `(() => {
  class U { constructor(t) { this.text = t; this.lang = ''; this.voice = null } }
  const say = t => { try { const a = JSON.parse(localStorage.getItem('__said') || '[]'); a.push(t); localStorage.setItem('__said', JSON.stringify(a)) } catch (e) {} }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: U, configurable: true })
  Object.defineProperty(window, 'speechSynthesis', { value: { speak: u => say(u.text), cancel() {}, getVoices: () => [{ lang: 'en-US', name: 'Recorder' }] }, configurable: true })
})()`

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  mkdirSync(OUT, { recursive: true })
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  type AuthAdmin = { auth: { admin: { listUsers: (a: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown>; createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>; updateUserById: (id: string, a: object) => Promise<unknown> } } }
  const A = (supabaseAdmin as unknown as AuthAdmin).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")

  // clean an earlier run (local test database only)
  await db.query("set session_replication_role = replica")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA vo %'")).rows.map(x => x.id)
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qvo-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qvo-%'")
  if (oldTeams.length) {
    await db.query("delete from marketing_team_messages where team_id = any($1)", [oldTeams])
    await db.query("delete from marketing_chat_thread_members where thread_id in (select id from marketing_chat_threads where team_id = any($1))", [oldTeams])
    await db.query("delete from marketing_chat_threads where team_id = any($1)", [oldTeams])
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-vo-"))) await A.deleteUser(u.id)
  await db.query("insert into storage.buckets (id, name, public) values ('onboarding-uploads', 'onboarding-uploads', false) on conflict do nothing")

  const teamA = (await S.createTeam({ name: `QA vo A ${stamp}`, actor: "qa-vo" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-vo")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-vo", permissions: [] as string[] }
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
  const L = (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, answers) values ($1,$2,'Voice Test Lead','voice@example.test','+393339990000','new','Ad Alpha', now() - interval '2 hours', null, null, '[]'::jsonb) returning id", [teamA.id, `qvo-lead-${stamp}`])).rows[0].id as string

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
    await ctx.addCookies([{ name: "tdm_lang", value: "en", domain: new URL(BASE).hostname, path: "/" }])
    await ctx.addInitScript(RECORDER)
    await page.close()
    return ctx
  }
  await A.updateUserById(ids.ownerA, { user_metadata: { full_name: "Rocco" } }); await A.updateUserById(ids.setterA, { user_metadata: { full_name: "Cristina" } })

  const adminCtx = await session(em("admin")), rocco = await session(em("ownerA")), setter = await session(em("setterA"))
  const open = async (ctx: BrowserContext, path: string) => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "load", timeout: 180000 }); await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); await p.waitForTimeout(1500); return p }
  const callOnce = (p: Page, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) } }, [method, path, payload ?? null] as const)
  const call = async (p: Page, method: string, path: string, payload?: object) => { for (let i = 0; ; i++) { try { return await callOnce(p, method, path, payload) } catch (e) { if (i >= 4 || !/context was destroyed|navigation/i.test(String(e))) throw e; await p.waitForTimeout(2500) } } }
  const said = async (p: Page): Promise<string[]> => JSON.parse((await p.evaluate(() => localStorage.getItem("__said"))) ?? "[]")
  const count = async (p: Page, phrase: string) => (await said(p)).filter(s => s === phrase).length
  // waits (up to ~90 s: one look every 15 s, and a busy machine answers slowly) until the page has said this phrase n times in all
  const waitCount = async (p: Page, phrase: string, n: number, ms = 90000) => { const until = Date.now() + ms; while (Date.now() < until) { if ((await count(p, phrase)) >= n) return true; await p.waitForTimeout(1000) } return (await count(p, phrase)) >= n }
  const quiet = async (p: Page, ms = 40000) => { await p.waitForTimeout(ms) }

  // Antonio joins the team (the Teams page button does the same); he stays an admin login
  const ap = await open(adminCtx, "/marketing-leads")
  ck("V0 Antonio joined the team", (await call(ap, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})).status === 200)
  const rp = await open(rocco, "/marketing"), sp = await open(setter, "/marketing")
  const send = (p: Page, lane: string, message: string) => call(p, "POST", `/api/marketing/chat/${L}/messages?lane=${lane}`, { message })

  // ---- 1. the back link
  const chatPage = await open(adminCtx, "/marketing/chat")
  const back = chatPage.getByTestId("back-to-home")
  ck("V1 his top-left link says Home and opens his Marketing Home, not the CRM", (await back.count()) === 1 && /Home/.test(await back.innerText()) && (await back.getAttribute("href")) === "/marketing-leads" && (await chatPage.getByTestId("back-to-crm").count()) === 0, { href: await back.getAttribute("href").catch(() => null) })
  await chatPage.screenshot({ path: `${OUT}/1-owner-frame-home-link-and-sound-switch.png` })
  await back.click()
  await chatPage.waitForURL(/\/marketing-leads$/, { timeout: 120000 }).catch(() => undefined)
  ck("V1b clicking it lands on his Marketing Home", /\/marketing-leads$/.test(chatPage.url()), chatPage.url())

  // ---- 2. Sound is off until he switches it on
  const home = await open(adminCtx, "/marketing-leads")
  const sw = home.getByTestId("voice-switch")
  ck("V2 Sound is Off by default, and the switch is in his Marketing menu", (await sw.count()) === 1 && /Sound: Off/.test(await sw.innerText()), await sw.innerText().catch(() => null))
  await send(rp, "owners", "OFF-ONE ciao Antonio")
  await quiet(home, 22000)
  ck("V2b while Sound is Off nothing is said", (await said(home)).length === 0, await said(home))

  // ---- 3. switch it on
  await sw.click()
  ck("V3 the switch now says On, the choice is kept, and the voice confirms 'Sound on'", /Sound: On/.test(await sw.innerText()) && (await home.evaluate(() => localStorage.getItem("tdm_voice"))) === "on" && (await count(home, "Sound on")) === 1, { said: await said(home) })
  await home.screenshot({ path: `${OUT}/2-crm-marketing-menu-sound-on.png` })
  ck("V3b switching it on does NOT read out the messages that were already there", (await count(home, "Message from Rocco")) === 0, await said(home))

  // ---- 4. a new message from Rocco is spoken, once
  const w1 = await send(rp, "owners", "SPOKEN-ONE come va?")
  ck("V4a Rocco writes to Antonio", w1.status === 200, w1)
  ck("V4 within a minute the page says 'Message from Rocco'", await waitCount(home, "Message from Rocco", 1), await said(home))
  await quiet(home, 20000)
  ck("V4b and says it ONCE for that message", (await count(home, "Message from Rocco")) === 1, await said(home))

  // ---- 5. who is NOT announced
  const w2 = await send(rp, "setter", "SETTER-LANE-ONE per Cristina")
  const own = await send(ap, "owners", "ANTONIO-OWN scrivo io")
  ck("V5a Rocco writes in the setter chat, Antonio writes in his own", w2.status === 200 && own.status === 200, [w2.status, own.status])
  await quiet(home, 35000)
  ck("V5 nothing is said for the setter chat (Antonio never reads it) nor for his own message", (await count(home, "Message from Rocco")) === 1 && (await said(home)).filter(s => /Antonio/.test(s)).length === 0, await said(home))

  // ---- 6. a second tab of the same browser does not say it twice
  const tab2 = await open(adminCtx, "/marketing/news")
  const w3 = await send(rp, "owners", "TWO-TABS-ONE altro messaggio")
  ck("V6a Rocco writes again", w3.status === 200, w3)
  ck("V6 two tabs are open: the message is said once in all", await waitCount(home, "Message from Rocco", 2), await said(home))
  await quiet(home, 20000)
  ck("V6b still exactly twice in all, not four times", (await count(home, "Message from Rocco")) === 2, await said(home))
  await tab2.close()

  // ---- 7. a direct message
  const th = await call(rp, "POST", "/api/marketing/team-chat/threads", { kind: "dm", user_id: ids.admin })
  const threadId = th.body?.thread_id as string | undefined
  const dm = threadId ? await call(rp, "POST", `/api/marketing/team-chat/${threadId}/messages`, { message: "DM-ONE solo tra noi" }) : { status: 0 }
  ck("V7a Rocco opens a direct message to Antonio and writes", dm.status === 200, { th: th.status, dm: dm.status })
  ck("V7 a direct message is announced too", await waitCount(home, "Message from Rocco", 3), await said(home))

  // ---- 8. the words of a message never travel in the alert
  const a = await call(home, "GET", `/api/marketing/chat/alerts?since=${encodeURIComponent(new Date(Date.now() - 600000).toISOString())}`)
  const items = (a.body?.items ?? []) as Array<Record<string, unknown>>
  ck("V8 the answer carries only id, kind, first name and time (never a word of any message)", a.status === 200 && items.length > 0 && items.every(i => Object.keys(i).sort().join() === "at,id,kind,sender") && !JSON.stringify(a.body).match(/SPOKEN|TWO-TABS|DM-ONE|OFF-ONE/), a.body)

  // ---- 9. View as does not change what he hears
  await call(ap, "POST", "/api/marketing-admin/view-as", { teamId: teamA.id, as: "setter" })
  const va = await call(ap, "GET", `/api/marketing/chat/alerts?since=${encodeURIComponent(new Date(Date.now() - 600000).toISOString())}`)
  const settersMsg = w2.body?.message?.id
  ck("V9 with a View-as left on, Antonio still hears HIS chats only: the setter chat is not in his alerts", va.status === 200 && settersMsg && !(va.body?.items ?? []).some((i: { id: string }) => i.id === settersMsg), va.body)
  await call(ap, "DELETE", "/api/marketing-admin/view-as")

  // ---- 10. switch it off
  await home.reload({ waitUntil: "load", timeout: 180000 }); await home.waitForTimeout(1500)
  const sw2 = home.getByTestId("voice-switch")
  ck("V10a the choice is still On after a reload", /Sound: On/.test(await sw2.innerText()))
  await sw2.click()
  ck("V10b switching it Off is kept", /Sound: Off/.test(await sw2.innerText()) && (await home.evaluate(() => localStorage.getItem("tdm_voice"))) === "off")
  const before = (await said(home)).length
  await send(rp, "owners", "AFTER-OFF dopo lo spegnimento")
  await quiet(home, 35000)
  ck("V10 after switching Off nothing more is said", (await said(home)).length === before, await said(home))

  // ---- 11. the setter hears her own chat only
  const ssw = sp.getByTestId("voice-switch")
  ck("V11a the setter's menu has the switch (in her own words)", (await ssw.count()) === 1)
  await ssw.click()
  const w4 = await send(rp, "owners", "OWNERS-ONLY riservato")
  const w5 = await send(rp, "setter", "FOR-CRISTINA per te")
  ck("V11b Rocco writes in the owners chat and in the setter chat", w4.status === 200 && w5.status === 200, [w4.status, w5.status])
  ck("V11 the setter hears 'Message from Rocco' once (for HER chat)", await waitCount(sp, "Message from Rocco", 1), await said(sp))
  await quiet(sp, 20000)
  ck("V11c and not for the owners chat (still exactly once)", (await count(sp, "Message from Rocco")) === 1, await said(sp))
  await sp.screenshot({ path: `${OUT}/3-setter-menu-sound-on.png` })

  // ---- 12. the "click anywhere to start" bar: a page nobody has touched, with Sound on, says so; a click removes it; with Sound off there is no bar
  await home.evaluate(() => localStorage.setItem("tdm_voice", "on"))
  const fresh = await adminCtx.newPage()
  await fresh.goto(`${BASE}/marketing-leads`, { waitUntil: "load", timeout: 180000 })
  await fresh.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined)
  await fresh.waitForTimeout(2500)
  const bar = fresh.getByTestId("voice-wake-bar")
  ck("V12 Sound is on and nobody touched this page yet: a clear bar says 'click anywhere to start'", (await bar.count()) === 1 && /click anywhere/i.test(await bar.innerText()), await bar.count())
  await fresh.screenshot({ path: `${OUT}/4-wake-bar.png` })
  await fresh.mouse.click(5, 300)
  await fresh.waitForTimeout(800)
  ck("V12b one click anywhere and the bar is gone", (await bar.count()) === 0)
  await home.evaluate(() => localStorage.setItem("tdm_voice", "off"))
  const fresh2 = await adminCtx.newPage()
  await fresh2.goto(`${BASE}/marketing-leads`, { waitUntil: "load", timeout: 180000 })
  await fresh2.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined)
  await fresh2.waitForTimeout(2000)
  ck("V12c with Sound off there is no bar", (await fresh2.getByTestId("voice-wake-bar").count()) === 0)

  await browser.close(); await db.end()
  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
