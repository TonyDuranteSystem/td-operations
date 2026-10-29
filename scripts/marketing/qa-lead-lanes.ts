/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa; Antonio, 29 Oct 2026: two chats per lead). Through the REAL login, the REAL dev server and the REAL database:
   every lead has two chats, "owners" (Antonio and Rocco) and "setter" (Rocco and the setter). Rocco has two buttons ("Discuss with Antonio", "Discuss with Cristina"), the setter one ("Discuss with Rocco"),
   Antonio one ("Chat with Rocco"). Nobody is ever handed a chat that is not theirs: not by the screen, not by the address, not by writing to it, not by the Messages list or the unread numbers.
   Needs: the private stack up (with migration 20261029-2100) and `td-marketing-dev` on :3010. Run: npx tsx scripts/marketing/qa-lead-lanes.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const stamp = Date.now()
const em = (k: string) => `qa-ln-${k.toLowerCase()}@example.test`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  type AuthAdmin = { auth: { admin: { listUsers: (a: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown>; createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }
  const A = (supabaseAdmin as unknown as AuthAdmin).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")

  // clean an earlier run (local test database only)
  await db.query("set session_replication_role = replica")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA ln %'")).rows.map(x => x.id)
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qln-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qln-%'")
  if (oldTeams.length) {
    await db.query("delete from marketing_team_messages where team_id = any($1)", [oldTeams])
    await db.query("delete from marketing_chat_thread_members where thread_id in (select id from marketing_chat_threads where team_id = any($1))", [oldTeams])
    await db.query("delete from marketing_chat_threads where team_id = any($1)", [oldTeams])
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-ln-"))) await A.deleteUser(u.id)
  await db.query("insert into storage.buckets (id, name, public) values ('onboarding-uploads', 'onboarding-uploads', false) on conflict do nothing")

  const teamA = (await S.createTeam({ name: `QA ln A ${stamp}`, actor: "qa-ln" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-ln")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-ln", permissions: [] as string[] }
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
  const mkLead = async (n: string, name: string) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, answers) values ($1,$2,$3,$4,'+393339990000','new','Ad Alpha', now() - interval '2 hours', null, null, '[]'::jsonb) returning id",
      [teamA.id, `qln-${n}-${stamp}`, name, `${n}@example.test`])).rows[0].id as string

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
  async function session(email: string, lang = "en", br = browser): Promise<BrowserContext> {
    const ctx = await br.newContext({ viewport: { width: 1440, height: 1000 } })
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
  // profile names: the buttons carry them
  const upd = (id: string, meta: object) => (A as unknown as { updateUserById: (id: string, a: object) => Promise<unknown> }).updateUserById(id, { user_metadata: meta })
  await upd(ids.ownerA, { full_name: "Rocco" }); await upd(ids.setterA, { full_name: "Cristina" })
  const L = await mkLead("lane", "Lane Test Lead")

  const adminCtx = await session(em("admin"))
  const rocco = await session(em("ownerA"))
  const setter = await session(em("setterA"))
  const open = async (ctx: BrowserContext, path: string) => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "load", timeout: 180000 }); await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); return p }
  const callOnce = (p: import("playwright").Page, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) } }, [method, path, payload ?? null] as const)
  // a page that is still redirecting when the call starts ("execution context was destroyed") is tried again, never counted as a failure of the app
  const call = async (p: import("playwright").Page, method: string, path: string, payload?: object) => { for (let i = 0; ; i++) { try { return await callOnce(p, method, path, payload) } catch (e) { if (i >= 4 || !/context was destroyed|navigation/i.test(String(e))) throw e; await p.waitForTimeout(2500) } } }

  // Antonio joins the team as a member (the Teams page button does the same); he stays an admin login
  const ap = await open(adminCtx, "/marketing-leads")
  const add = await call(ap, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})
  ck("L0 Antonio joined the team", add.status === 200, add)
  const rp = await open(rocco, "/marketing"), sp = await open(setter, "/marketing")

  // who may use which chat
  const aChat = (lane: string) => call(ap, "GET", `/api/marketing/chat/${L}?lane=${lane}&mark_read=0`)
  const rChat = (lane: string) => call(rp, "GET", `/api/marketing/chat/${L}?lane=${lane}&mark_read=0`)
  const sChat = (lane: string) => call(sp, "GET", `/api/marketing/chat/${L}?lane=${lane}&mark_read=0`)
  ck("L1 Antonio opens the owners chat", (await aChat("owners")).status === 200)
  ck("L2 Antonio is refused the setter chat by address", (await aChat("setter")).status === 403)
  ck("L3 Rocco opens both", (await rChat("owners")).status === 200 && (await rChat("setter")).status === 200)
  ck("L4 the setter opens the setter chat and is refused the owners chat", (await sChat("setter")).status === 200 && (await sChat("owners")).status === 403)

  // writing
  const send = (p: import("playwright").Page, lane: string, message: string) => call(p, "POST", `/api/marketing/chat/${L}/messages?lane=${lane}`, { message })
  const w1 = await send(rp, "owners", "SECRET-ANTONIO ci vediamo lunedi")
  const w2 = await send(rp, "setter", "FOR-CRISTINA ho chiamato il lead")
  const w3 = await send(ap, "owners", "ANTONIO-TO-ROCCO ok")
  ck("L5 Rocco writes in both chats, Antonio in the owners one", w1.status === 200 && w2.status === 200 && w3.status === 200, [w1.status, w2.status, w3.status])
  ck("L6 the setter cannot write in the owners chat, Antonio cannot write in the setter chat", (await send(sp, "owners", "x")).status === 403 && (await send(ap, "setter", "x")).status === 403)
  const sSees = JSON.stringify((await sChat("setter")).body?.messages ?? [])
  ck("L7 the setter reads the setter chat and nothing of the owners chat", /FOR-CRISTINA/.test(sSees) && !/SECRET-ANTONIO|ANTONIO-TO-ROCCO/.test(sSees), sSees.slice(0, 300))
  const aSees = JSON.stringify((await aChat("owners")).body?.messages ?? [])
  ck("L8 Antonio reads the owners chat and nothing of the setter chat", /SECRET-ANTONIO/.test(aSees) && /ANTONIO-TO-ROCCO/.test(aSees) && !/FOR-CRISTINA/.test(aSees), aSees.slice(0, 300))
  const ids2 = ((await rChat("owners")).body?.messages ?? []).map((m: { id: string }) => m.id)
  const edit = await call(sp, "PATCH", `/api/marketing/chat/messages/${ids2[0]}`, { message: "hacked" })
  ck("L9 the setter cannot edit, react to or read a message of the owners chat by its id", edit.status === 404 && (await call(sp, "POST", `/api/marketing/chat/messages/${ids2[0]}/react`, { emoji: "👍" })).status === 404, edit.status)

  // the message menu in each chat: pin, react, mark unread — through the lane the chat is on
  const own = ids2[0] as string
  const pin = await call(rp, "POST", `/api/marketing/chat/${L}/pin?lane=owners`, { message_id: own, pinned: true })
  ck("L9b Rocco pins a message of the owners chat through its lane", pin.status === 200 && !!pin.body?.pinned_at, pin)
  const sPin = await call(sp, "POST", `/api/marketing/chat/${L}/pin?lane=setter`, { message_id: own, pinned: true })
  ck("L9c the setter cannot pin a message of the owners chat, even naming her own lane", sPin.status === 404, sPin)
  const react = await call(rp, "POST", `/api/marketing/chat/messages/${own}/react`, { emoji: "👍" })
  ck("L9d Rocco reacts to a message of the owners chat", react.status === 200, react)
  const unreadMark = await call(rp, "POST", `/api/marketing/chat/${L}/unread?lane=owners`, { message_id: own })
  ck("L9e Rocco marks a message of the owners chat unread, through its lane", unreadMark.status === 200, unreadMark)

  // lists and numbers
  const sList = JSON.stringify((await call(sp, "GET", "/api/marketing/chat/conversations")).body)
  ck("L10 the setter's Messages list holds her chat only, named after Rocco", /Discuss with Rocco/.test(sList) && !/SECRET|owners/.test(sList) && !/Discuss with Antonio/.test(sList), sList.slice(0, 400))
  const rList = ((await call(rp, "GET", "/api/marketing/chat/conversations")).body?.conversations ?? []) as Array<{ lane: string; label: string }>
  ck("L11 Rocco's Messages list holds both chats of the lead, each named after the other side", rList.length === 2 && rList.some(c => c.lane === "owners" && c.label === "Discuss with Antonio") && rList.some(c => c.lane === "setter" && c.label === "Discuss with Cristina"), rList)
  const aList = ((await call(ap, "GET", "/api/marketing/chat/conversations")).body?.conversations ?? []) as Array<{ lane: string; label: string }>
  ck("L12 Antonio's Messages list holds the owners chat only", aList.length === 1 && aList[0].lane === "owners" && aList[0].label === "Chat with Rocco", aList)
  const un = (await call(rp, "GET", "/api/marketing/chat/unread")).body?.by_lane ?? {}
  ck("L13 Rocco's unread numbers are per chat: Antonio's message is in the owners chat only", un[`${L}|owners`] === 1 && !un[`${L}|setter`], un)
  const sun = (await call(sp, "GET", "/api/marketing/chat/unread")).body?.by_lane ?? {}
  ck("L14 the setter's unread numbers hold her chat only", sun[`${L}|setter`] === 1 && !sun[`${L}|owners`], sun)
  await call(rp, "GET", `/api/marketing/chat/${L}?lane=owners`)
  const un2 = (await call(rp, "GET", "/api/marketing/chat/unread")).body?.by_lane ?? {}
  ck("L15 reading the owners chat does not read the setter chat", !un2[`${L}|owners`], un2)

  // the screens
  const rw = await open(rocco, `/marketing/window/${L}`)
  const rTabs = (await rw.locator('[role="tab"]').allInnerTexts()).map(x => x.replace(/\s+/g, " ").trim())
  ck("L16 Rocco's lead window has Lead and two buttons", rTabs.length === 3 && rTabs.some(x => x.startsWith("Discuss with Antonio")) && rTabs.some(x => x.startsWith("Discuss with Cristina")), rTabs)
  await rw.getByTestId("tab-chat-setter").click()
  await rw.getByTestId("chat-pane").waitFor({ timeout: 30000 })
  await rw.getByText("FOR-CRISTINA").first().waitFor({ timeout: 45000 }).catch(() => undefined)
  const rwText = await rw.locator("body").innerText()
  ck("L17 'Discuss with Cristina' shows the setter chat, not the owners chat", (await rw.getByTestId("chat-pane").getAttribute("data-lane")) === "setter" && /FOR-CRISTINA/.test(rwText) && !/SECRET-ANTONIO/.test(rwText), rwText.slice(0, 300))
  await rw.screenshot({ path: `/tmp/qa-ln-rocco-setter-chat.png` })
  // the message toolbar inside a chat: a quick emoji reaches the server through the lane the chat is on
  await rw.getByTestId("tab-chat-owners").click()
  await rw.getByText("ANTONIO-TO-ROCCO").first().waitFor({ timeout: 45000 }).catch(() => undefined)
  const reactCalls: string[] = []
  rw.on("response", r => { if (/\/react$/.test(r.url())) reactCalls.push(`${r.request().method()} ${r.status()}`) })
  const row = rw.locator("[data-mid]").filter({ hasText: "ANTONIO-TO-ROCCO" })
  await row.hover()
  await row.getByTestId("talk-tool-emoji").click()
  await rw.getByTestId("talk-quick-👍").click()
  let nReacts = 0
  for (let i = 0; i < 40; i++) { nReacts = (await db.query("select count(*)::int n from marketing_lead_message_reactions where emoji='👍' and message_id in (select id from marketing_lead_messages where lead_id=$1 and sender_id=$2)", [L, ids.admin])).rows[0].n; if (nReacts) break; await rw.waitForTimeout(500) }
  ck("L17b a quick emoji from the toolbar of the owners chat is saved", nReacts >= 1, { nReacts, reactCalls })
  // the message menu: Pin and Mark unread, from the three dots of a message in the owners chat
  const row2 = rw.locator("[data-mid]").filter({ hasText: "SECRET-ANTONIO" })
  await row2.hover(); await row2.getByTestId("talk-tool-more").click()
  await rw.getByTestId("talk-act-pin").click()
  const secretId = (await db.query("select id from marketing_lead_messages where lead_id=$1 and message like 'SECRET-ANTONIO%'", [L])).rows[0].id
  let pinnedAt: string | null = null
  for (let i = 0; i < 60; i++) { pinnedAt = (await db.query("select pinned_at from marketing_lead_messages where id=$1", [secretId])).rows[0].pinned_at; if (pinnedAt) break; await rw.waitForTimeout(500) }
  ck("L17c Pin from the message menu of the owners chat is saved", !!pinnedAt, pinnedAt)
  const theirs2 = rw.locator("[data-mid]").filter({ hasText: "ANTONIO-TO-ROCCO" })
  await theirs2.hover(); await theirs2.getByTestId("talk-tool-more").click()
  await rw.getByTestId("talk-act-unread").click()
  const antId = (await db.query("select id, created_at from marketing_lead_messages where lead_id=$1 and message like 'ANTONIO-TO-ROCCO%'", [L])).rows[0]
  let pos: string | null = null
  for (let i = 0; i < 80; i++) { pos = (await db.query("select last_read_at from marketing_lead_lane_reads where lead_id=$1 and lane='owners' and user_id=$2", [L, ids.ownerA])).rows[0]?.last_read_at ?? null; if (pos && new Date(pos).getTime() < new Date(antId.created_at).getTime()) break; await rw.waitForTimeout(500) }
  ck("L17d Mark unread from the message menu moves Rocco's place in the owners chat back", !!pos && new Date(pos).getTime() < new Date(antId.created_at).getTime(), { pos, at: antId.created_at })
  const sw = await open(setter, `/marketing/window/${L}`)
  const sTabs = (await sw.locator('[role="tab"]').allInnerTexts()).map(x => x.replace(/\s+/g, " ").trim())
  ck("L18 the setter's window has Lead and one button, 'Discuss with Rocco'", sTabs.length === 2 && sTabs[1].startsWith("Discuss with Rocco"), sTabs)
  await sw.getByTestId("tab-chat").click(); await sw.waitForTimeout(3500)
  const swText = await sw.locator("body").innerText()
  ck("L19 her chat shows Rocco's message to her and nothing of the owners chat", /FOR-CRISTINA/.test(swText) && !/SECRET-ANTONIO|ANTONIO-TO-ROCCO/.test(swText), swText.slice(0, 300))
  await sw.screenshot({ path: `/tmp/qa-ln-setter-chat.png` })
  const aw = await open(adminCtx, `/marketing/window/${L}`)
  const aTabs = (await aw.locator('[role="tab"]').allInnerTexts()).map(x => x.replace(/\s+/g, " ").trim())
  ck("L20 Antonio's window has Lead and one button, 'Chat with Rocco'", aTabs.length === 2 && aTabs[1].startsWith("Chat with Rocco"), aTabs)

  // Antonio previews the setter: he sees her chat (the whole of it), never the owners chat
  await ap.request.post(`${BASE}/api/marketing-admin/view-as`, { data: { teamId: teamA.id, as: "setter" } })
  const vSet = JSON.stringify((await call(ap, "GET", `/api/marketing/chat/${L}?lane=setter&mark_read=0`)).body?.messages ?? [])
  const vOwn = (await call(ap, "GET", `/api/marketing/chat/${L}?lane=owners&mark_read=0`)).status
  ck("L21 'View as Setter' shows the setter chat and refuses the owners chat", /FOR-CRISTINA/.test(vSet) && vOwn === 403, { vOwn })

  console.log(`\n${pass} passed, ${fail} failed`)
  await browser.close()
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
