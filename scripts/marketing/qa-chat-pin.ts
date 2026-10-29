/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa): proves PIN in chats through the REAL login page: pin/unpin by API and from the message menu, the pinned bar (count, step through, jump), a setter never sees or touches a pin of a message she cannot read,
   a deleted message cannot be pinned, a team conversation pins the same way, and a database without the pin columns still loads the chat (no pins, a clear message on pin).
   Needs: the private stack up (with migration 20261028-2300-marketing-chat-pin.sql) and `td-marketing-dev` on :3010.
   Run: npx tsx scripts/marketing/qa-chat-pin.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-pn-${k.toLowerCase()}@example.test`
let fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (!ok) fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

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
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA pn %'")).rows.map(x => x.id)
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qpn-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qpn-%'")
  if (oldTeams.length) {
    await db.query("delete from marketing_team_messages where team_id = any($1)", [oldTeams])
    await db.query("delete from marketing_chat_thread_members where thread_id in (select id from marketing_chat_threads where team_id = any($1))", [oldTeams])
    await db.query("delete from marketing_chat_threads where team_id = any($1)", [oldTeams])
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-pn-"))) await A.deleteUser(u.id)
  await db.query("insert into storage.buckets (id, name, public) values ('onboarding-uploads', 'onboarding-uploads', false) on conflict do nothing")

  const teamA = (await S.createTeam({ name: `QA pn A ${stamp}`, actor: "qa-pn" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-pn")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-pn", permissions: [] as string[] }
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
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter"); await mk("sellerA", "member", "seller")
  {
    const r = await A.createUser({ email: em("admin"), password: PASS, email_confirm: true, app_metadata: { role: "admin" }, user_metadata: { full_name: "Qa Od Admin" } })
    if (r.error || !r.data.user) throw new Error(`seed admin: ${r.error?.message}`)
    ids.admin = r.data.user.id
    await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'x')`, [ids.admin])
  }
  // the guided tour has been seen by everybody (its dark overlay would otherwise cover the page)
  for (const uid of Object.values(ids)) for (const k of ["setter", "seller", "content", "analyst", "owner"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) values ($1,$2,$3,'done') on conflict do nothing", [uid, teamA.id, k])
  const mkLead = async (n: string, name: string, o: { status?: string; team?: string | null; claimed?: string | null; hoursAgo?: number } = {}) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, answers) values ($1,$2,$3,$4,'+393339990000',$5,'Ad Alpha', now() - ($6 || ' hours')::interval, $7, $8, '[]'::jsonb) returning id",
      [o.team === undefined ? teamA.id : o.team, `qpn-${n}-${stamp}`, name, `${n}@example.test`, o.status ?? "new", String(o.hoursAgo ?? 30), o.claimed ?? null, o.claimed ? em("sellerA") : null])).rows[0].id as string
  const Llink = await mkLead("link", "Unpaid Link Lead", { status: "closed", claimed: ids.sellerA, hoursAgo: 80 })
  await db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,'payment_link_created',$2,'{\"sale_id\":\"qpn-sale-1\"}'::jsonb, now() - interval '50 hours')", [Llink, em("sellerA")])

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
  type Pg = import("playwright").Page
  const adminCtx = await session(em("admin")), setter = await session(em("setterA")), owner = await session(em("ownerA"))
  const open = async (ctx: BrowserContext, path = "/marketing") => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "load", timeout: 180000 }); await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); await p.waitForTimeout(2500); return p }
  const apiOnce = (p: Pg, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) } }, [method, path, payload ?? null] as [string, string, object | null])
  // a page that is still settling can swap its document under the call: wait and try again
  const api = async (p: Pg, method: string, path: string, payload?: object) => { for (let i = 0; ; i++) { try { return await apiOnce(p, method, path, payload) } catch (e) { if (i >= 4 || !/context was destroyed|navigation/i.test(String(e))) throw e; await p.waitForLoadState("load").catch(() => undefined); await p.waitForTimeout(1500) } } }

  const adminP = await open(adminCtx, "/marketing-leads")
  const add = await api(adminP, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})
  ck("P0 the admin joined the team as owner", add.status === 200, add)

  const Lp = await mkLead("pin", "Pin Lead", { status: "seller_contacted", claimed: ids.ownerA, hoursAgo: 3 })
  const say = async (pg: Pg, lead: string, message: string) => api(pg, "POST", `/api/marketing/chat/${lead}/messages`, { message })
  const idOf = async (text: string) => (await db.query("select id from marketing_lead_messages where lead_id=$1 and message=$2 order by created_at desc limit 1", [Lp, text])).rows[0]?.id as string
  const pinnedAt = async (id: string) => (await db.query("select pinned_at from marketing_lead_messages where id=$1", [id])).rows[0]?.pinned_at ?? null
  await say(adminP, Lp, "Rocco, call him today"); await say(adminP, Lp, "Second note for Rocco"); await say(adminP, Lp, "Ale, can you check his number?")
  const m1 = await idOf("Rocco, call him today"), m2 = await idOf("Second note for Rocco"), m3 = await idOf("Ale, can you check his number?")
  // the message to the setter belongs to the SETTER chat (Rocco and the setter); the other two stay in the owners chat
  await db.query("update marketing_lead_messages set mentions = array[$1]::uuid[], lane = 'setter' where id=$2", [ids.setterA, m3])
  const ownerP = await open(owner, "/marketing/board")
  const setterP = await open(setter, "/marketing/call-list")

  // ---- 1. by API: who may pin what
  const p1 = await api(ownerP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: m1, pinned: true })
  ck("P1 Rocco pins a message (saved, with the time)", p1.status === 200 && !!(await pinnedAt(m1)), p1)
  const p2 = await api(setterP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: m1, pinned: true })
  ck("P2 the setter cannot pin or unpin a message she may not read (404, nothing changed)", p2.status === 404, p2)
  const p2b = await api(setterP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: m1, pinned: false })
  ck("P2b ... nor unpin it (404, the pin is still there)", p2b.status === 404 && !!(await pinnedAt(m1)), p2b)
  const p3 = await api(setterP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: m3, pinned: true })
  ck("P3 the setter CAN pin a message in her own chat", p3.status === 200 && !!(await pinnedAt(m3)), p3)
  const sChat = await api(setterP, "GET", `/api/marketing/chat/${Lp}`)
  const sMsgs = (sChat.body?.messages ?? []) as Array<{ id: string; pinned_at?: string | null }>
  ck("P4 the setter's chat holds only what she may read: the pin of the message that names her, never the other pin or its text", sChat.status === 200 && sMsgs.some(m => m.id === m3 && !!m.pinned_at) && !sMsgs.some(m => m.id === m1) && !JSON.stringify(sChat.body).includes("Rocco, call him today"), { status: sChat.status, ids: sMsgs.map(m => m.id) })
  const pinsOf = async (lane: string) => (((await api(ownerP, "GET", `/api/marketing/chat/${Lp}?lane=${lane}`)).body?.messages ?? []) as Array<{ id: string; pinned_at?: string | null }>).filter(m => m.pinned_at).map(m => m.id).sort()
  const pinnedIds = [...(await pinsOf("owners")), ...(await pinsOf("setter"))].sort()
  ck("P5 Rocco's two chats carry the two pins, one each", JSON.stringify(pinnedIds) === JSON.stringify([m1, m3].sort()) && (await pinsOf("owners")).length === 1, pinnedIds)
  const p6 = await api(ownerP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: "00000000-0000-4000-8000-000000000000", pinned: true })
  ck("P6 a message that does not exist is a 404", p6.status === 404, p6)
  // from here the window checks use ONE chat with all three messages (the pinned bar steps through two pins): the setter-chat message goes back to the owners chat
  await db.query("update marketing_lead_messages set lane = 'owners' where id=$1", [m3])

  const barHas = async (p: Pg, re: RegExp) => { try { await p.waitForFunction(([sel, src]) => new RegExp(src as string).test((document.querySelector(sel as string) as HTMLElement | null)?.innerText.replace(/\\s+/g, " ") ?? ""), ["[data-testid=pinned-bar]", re.source], { timeout: 20000 }); return true } catch { return false } }
  // ---- 2. in the chat window: the bar, stepping through, jumping, pin and unpin from the message menu
  const wp = await open(owner, `/marketing/window/${Lp}?role=seller`)
  await wp.locator('[data-testid^="tab-chat"]').first().click().catch(() => undefined)
  await wp.getByTestId("lead-chat").waitFor({ timeout: 60000 })
  await wp.getByTestId("pinned-bar").waitFor({ timeout: 60000 })
  const bar1 = (await wp.getByTestId("pinned-bar").innerText()).replace(/\s+/g, " ")
  ck("P7 the pinned bar shows the newest pin and 'message 1 of 2'", /1 of 2/.test(bar1) && /Ale, can you check/.test(bar1), bar1)
  await wp.getByTestId("pinned-next").click()
  const bar2 = (await wp.getByTestId("pinned-bar").innerText()).replace(/\s+/g, " ")
  ck("P7b the arrow steps to the other pin ('2 of 2')", /2 of 2/.test(bar2) && /Rocco, call him today/.test(bar2), bar2)
  await wp.getByTestId("pinned-open").click()
  await wp.waitForTimeout(1500)
  ck("P7c clicking the bar jumps to that message", (await wp.locator(`[data-mid="${m1}"]`).count()) === 1)
  await wp.screenshot({ path: `${SHOTS}/qa-pin-bar.png` })
  // pin m2 from the menu (long text: use the toolbar's three dots)
  const row2 = wp.locator(`[data-mid="${m2}"]`)
  await row2.hover(); await row2.getByTestId("talk-tool-more").click()
  ck("P8 the message menu offers 'Pin' on a message that is not pinned", /Pin$/.test((await wp.getByTestId("talk-act-pin").innerText()).trim()))
  await wp.getByTestId("talk-act-pin").click()
  let s2 = null as unknown
  for (let i = 0; i < 20; i++) { s2 = await pinnedAt(m2); if (s2) break; await wp.waitForTimeout(500) }
  ck("P8b pinning from the menu saves it, and the bar now counts three", !!s2 && (await barHas(wp, /of 3/)), s2)
  await row2.hover(); await row2.getByTestId("talk-tool-more").click()
  ck("P9 on a pinned message the menu says 'Unpin'", /Unpin/.test(await wp.getByTestId("talk-act-pin").innerText()))
  await wp.getByTestId("talk-act-pin").click()
  let s3 = "x" as unknown
  for (let i = 0; i < 20; i++) { s3 = await pinnedAt(m2); if (!s3) break; await wp.waitForTimeout(500) }
  ck("P9b unpinning clears it and the bar counts two again", !s3 && (await barHas(wp, /of 2/)), s3)
  // a refresh shows the same bar for everybody who can see the messages
  await wp.reload({ waitUntil: "load", timeout: 150000 })
  await wp.locator('[data-testid^="tab-chat"]').first().click().catch(() => undefined)
  await wp.getByTestId("pinned-bar").waitFor({ timeout: 60000 })
  ck("P10 after a refresh the pins are still there", await barHas(wp, /of 2/))
  const aw = await open(adminCtx, `/marketing/window/${Lp}?role=seller`)
  await aw.locator('[data-testid^="tab-chat"]').first().click().catch(() => undefined)
  await aw.getByTestId("pinned-bar").waitFor({ timeout: 60000 })
  ck("P10b Antonio (the other person in the chat) sees the same pins", await barHas(aw, /of 2/))

  // ---- 3. deleted messages
  const del = await api(adminP, "DELETE", `/api/marketing/chat/messages/${m1}`)
  ck("P11 a deleted message leaves the bar (one pin left) and cannot be pinned again", del.status === 200, del)
  const again = await api(ownerP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: m1, pinned: true })
  ck("P11b pinning a deleted message is refused (400)", again.status === 400, again)
  await wp.reload({ waitUntil: "load", timeout: 150000 })
  await wp.locator('[data-testid^="tab-chat"]').first().click().catch(() => undefined)
  await wp.getByTestId("pinned-bar").waitFor({ timeout: 60000 })
  const barD = (await wp.getByTestId("pinned-bar").innerText()).replace(/\s+/g, " ")
  ck("P11c the bar shows the one message left, with no 'of'", !/ of /.test(barD) && /Ale, can you check/.test(barD) && (await wp.getByTestId("pinned-next").count()) === 0, barD)

  // ---- 4. a team conversation pins the same way
  const th = await api(adminP, "POST", "/api/marketing/team-chat/threads", { kind: "dm", user_id: ids.ownerA })
  const threadId = th.body?.thread_id as string
  await api(adminP, "POST", `/api/marketing/team-chat/${threadId}/messages`, { message: "Team note to keep" })
  const tm = (await db.query("select id from marketing_team_messages where thread_id=$1 and message='Team note to keep'", [threadId])).rows[0]?.id as string
  const tp = await api(ownerP, "POST", `/api/marketing/team-chat/${threadId}/pin`, { message_id: tm, pinned: true })
  const tChat = await api(adminP, "GET", `/api/marketing/team-chat/${threadId}`)
  ck("P12 a team conversation pins too, and the other person's chat carries the pin", tp.status === 200 && ((tChat.body?.messages ?? []) as Array<{ id: string; pinned_at?: string | null }>).some(m => m.id === tm && !!m.pinned_at), { tp, status: tChat.status })
  const tBad = await api(ownerP, "POST", `/api/marketing/team-chat/${threadId}/pin`, { message_id: m2, pinned: true })
  ck("P12b a message of a lead chat cannot be pinned through a team conversation (404)", tBad.status === 404, tBad)

  // ---- 5. deploy before the migration: the chat loads without pins and pinning says so
  await db.query("alter table marketing_lead_messages drop column pinned_at, drop column pinned_by")
  await db.query("alter table marketing_team_messages drop column pinned_at, drop column pinned_by")
  try {
    const noCol = await api(ownerP, "GET", `/api/marketing/chat/${Lp}`)
    const noColSetter = await api(setterP, "GET", `/api/marketing/chat/${Lp}`)
    const noColTeam = await api(adminP, "GET", `/api/marketing/team-chat/${threadId}`)
    ck("P13 without the pin columns the chats still load (owner, setter, team conversation), with no pins", noCol.status === 200 && noColSetter.status === 200 && noColTeam.status === 200 && ((noCol.body?.messages ?? []) as Array<{ pinned_at?: string | null }>).length > 0 && ((noCol.body?.messages ?? []) as Array<{ pinned_at?: string | null }>).every(m => !m.pinned_at), { a: noCol.status, b: noColSetter.status, c: noColTeam.status })
    const noPin = await api(ownerP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: m2, pinned: true })
    ck("P13b pinning without the columns gives a clear message (503), not a crash", noPin.status === 503 && /not switched on/.test(noPin.body?.error ?? ""), noPin)
  } finally {
    await db.query("alter table marketing_lead_messages add column if not exists pinned_at timestamptz, add column if not exists pinned_by uuid")
    await db.query("alter table marketing_team_messages add column if not exists pinned_at timestamptz, add column if not exists pinned_by uuid")
  }


  // ---- 6. the review fixes: an already pinned message keeps its first pin, a deleted message's pin can be cleared, a pin older than the window stays in the bar
  await api(adminP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: m3, pinned: true })
  const first = (await db.query("select pinned_at, pinned_by from marketing_lead_messages where id=$1", [m3])).rows[0]
  const re = await api(ownerP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: m3, pinned: true })
  const after = (await db.query("select pinned_at, pinned_by from marketing_lead_messages where id=$1", [m3])).rows[0]
  ck("P14 pinning an already pinned message keeps the first pin (same time, same person) and says so", re.status === 200 && new Date(after.pinned_at).getTime() === new Date(first.pinned_at).getTime() && after.pinned_by === first.pinned_by && new Date(re.body.pinned_at).getTime() === new Date(first.pinned_at).getTime(), { first, after, re })
  await db.query("update marketing_lead_messages set pinned_at = now(), pinned_by = $2 where id = $1", [m1, ids.ownerA])
  const unDeleted = await api(ownerP, "POST", `/api/marketing/chat/${Lp}/pin`, { message_id: m1, pinned: false })
  ck("P15 the pin of a deleted message can be cleared (200, not an error)", unDeleted.status === 200 && !(await pinnedAt(m1)), unDeleted)
  const Lq = await mkLead("old", "Old Pin Lead", { status: "seller_contacted", claimed: ids.ownerA, hoursAgo: 5 })
  await db.query("insert into marketing_lead_messages (team_id, lead_id, sender_id, sender_name, message, created_at) values ($1,$2,$3,'Qa Pn Admin','The very first note to keep', now() - interval '3 days')", [teamA.id, Lq, ids.admin])
  await db.query("insert into marketing_lead_messages (team_id, lead_id, sender_id, sender_name, message, created_at) select $1,$2,$3,'Qa Pn Admin','filler '||g, now() - interval '2 days' + (g || ' seconds')::interval from generate_series(1,505) g", [teamA.id, Lq, ids.admin])
  const oldId = (await db.query("select id from marketing_lead_messages where lead_id=$1 and message='The very first note to keep'", [Lq])).rows[0].id as string
  await db.query("update marketing_lead_messages set pinned_at = now(), pinned_by = $2 where id = $1", [oldId, ids.admin])
  const big = await api(ownerP, "GET", `/api/marketing/chat/${Lq}`)
  const inWindow = ((big.body?.messages ?? []) as Array<{ id: string }>).some(m => m.id === oldId)
  const olderIds = ((big.body?.older_pins ?? []) as Array<{ id: string }>).map(m => m.id)
  ck("P16 a pin older than the newest 500 messages is not in the window but IS handed over as an older pin", big.status === 200 && !inWindow && olderIds.includes(oldId), { status: big.status, inWindow, olderIds })
  const small = await api(ownerP, "GET", `/api/marketing/chat/${Lp}`)
  ck("P16b a chat with fewer than 500 messages carries no older pins (no extra work)", (small.body?.older_pins ?? []).length === 0, small.body?.older_pins)
  const wq = await open(owner, `/marketing/window/${Lq}?role=seller`)
  await wq.locator('[data-testid^="tab-chat"]').first().click().catch(() => undefined)
  await wq.getByTestId("pinned-bar").waitFor({ timeout: 90000 })
  ck("P17 the bar still shows the old pin, with its words", /The very first note to keep/.test(await wq.getByTestId("pinned-bar").innerText()))
  await wq.getByTestId("pinned-unpin").click()
  let oldAt = "x" as unknown
  for (let i = 0; i < 40; i++) { oldAt = await pinnedAt(oldId); if (!oldAt) break; await wq.waitForTimeout(500) }
  await wq.waitForTimeout(1000)
  ck("P17b the X in the bar unpins it (saved, and the bar goes away)", !oldAt && (await wq.getByTestId("pinned-bar").count()) === 0, { oldAt, toast: (await wq.locator("[data-sonner-toast]").allInnerTexts()).join(" | ") })
  await wq.waitForTimeout(7000)
  ck("P17c a refresh a few seconds later does not bring it back", (await wq.getByTestId("pinned-bar").count()) === 0)

  console.log(fail ? `FAILED ${fail}` : "ALL PASSED")
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
