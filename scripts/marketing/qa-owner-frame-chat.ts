/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa; Antonio 28 Oct 2026): proves, through the REAL login page, that Antonio has HIS frame on every Marketing screen (never Rocco's), a new message never moves a card (tag + blink), the chat has a visible toolbar (emoji, reply, edit, more) and "Mark unread" works for him only, and Word files open in Documents. Based on the owner-dashboard harness: proves, through the REAL login page, the REAL dev server and the REAL database, that the
   owner (an admin who joined a team) has ONE menu on every Marketing screen, can act from Home (give a lead to a person or a team, answer a message, remind a person in private, upload a document), and that
   news he posts reaches exactly its audience, is marked read, shows who read it, and can be withdrawn.
   Needs: the private stack up (with migration 20261028-1200-marketing-news.sql) and `td-marketing-dev` on :3010.
   Run: npx tsx scripts/marketing/qa-owner-dashboard.ts */
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
const em = (k: string) => `qa-od-${k.toLowerCase()}@example.test`
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
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA od %'")).rows.map(x => x.id)
  await db.query("delete from marketing_news_reads")
  await db.query("delete from marketing_news")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qod-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qod-%'")
  if (oldTeams.length) {
    await db.query("delete from marketing_team_messages where team_id = any($1)", [oldTeams])
    await db.query("delete from marketing_chat_thread_members where thread_id in (select id from marketing_chat_threads where team_id = any($1))", [oldTeams])
    await db.query("delete from marketing_chat_threads where team_id = any($1)", [oldTeams])
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-od-"))) await A.deleteUser(u.id)
  await db.query("insert into storage.buckets (id, name, public) values ('onboarding-uploads', 'onboarding-uploads', false) on conflict do nothing")

  const teamA = (await S.createTeam({ name: `QA od A ${stamp}`, actor: "qa-od" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-od")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-od", permissions: [] as string[] }
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
      [o.team === undefined ? teamA.id : o.team, `qod-${n}-${stamp}`, name, `${n}@example.test`, o.status ?? "new", String(o.hoursAgo ?? 30), o.claimed ?? null, o.claimed ? em("sellerA") : null])).rows[0].id as string
  const Llink = await mkLead("link", "Unpaid Link Lead", { status: "closed", claimed: ids.sellerA, hoursAgo: 80 })
  await db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,'payment_link_created',$2,'{\"sale_id\":\"qod-sale-1\"}'::jsonb, now() - interval '50 hours')", [Llink, em("sellerA")])

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
  const text = async (p: Pg) => (await p.locator("body").innerText()).replace(/\s+/g, " ")


  const adminP = await open(adminCtx, "/marketing-leads")
  const add = await api(adminP, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})
  ck("G0 the admin joined the team as owner", add.status === 200, add)

  // ---- 1. HIS frame on every Marketing screen; the team's frame for Rocco (the owner who sells) and for everybody else
  for (const [k, path] of [["Messages (Chat)", "/marketing/chat"], ["Board", "/marketing/board"], ["Calendar", "/marketing/calendar"], ["Documents", "/marketing/documents"], ["Templates", "/marketing/templates"]] as const) {
    const pg = await open(adminCtx, path)
    const body = await text(pg)
    ck(`G1 ${k}: Antonio is in HIS frame (his menu, "Owner"), not Rocco's (no team name, no team menu)`, (await pg.getByTestId("frame-owner").count()) === 1 && (await pg.getByTestId("owner-nav").count()) === 1 && (await pg.getByTestId("frame-team").count()) === 0 && (await pg.getByTestId("nav-board").count()) === 0 && !/QA od A/.test(body), body.slice(0, 200))
    await pg.close()
  }
  const sellerPg = await open(owner, "/marketing/board")
  ck("G2 the team's own people (the owner who sells) are in the team's frame: team name, team menu, no owner menu", (await sellerPg.getByTestId("frame-team").count()) === 1 && (await sellerPg.getByTestId("owner-nav").count()) === 0 && /QA od A/.test(await text(sellerPg)))

  // ---- 2. a new message never moves a card: it stays in its stage, with the tag
  const Lm = await mkLead("msg", "Message Lead", { status: "seller_contacted", claimed: ids.ownerA, hoursAgo: 3 })
  const say = async (pg: Pg, lead: string, message: string) => api(pg, "POST", `/api/marketing/chat/${lead}/messages`, { message })
  const sent = await say(adminP, Lm, "Rocco, please call this lead today")
  ck("G3 Antonio writes to Rocco in the lead's chat", sent.status === 200, sent)
  const bp = await open(owner, "/marketing/board")
  const card = await bp.$$eval('[data-testid="board-card"]', els => els.map(e => ({ id: e.getAttribute("data-lead"), col: e.closest("[data-column]")?.getAttribute("data-column") ?? null, tag: (e.querySelector('[data-testid="card-unread"]')?.textContent ?? "").trim(), cls: e.className })))
  const cm = card.find(c => c.id === Lm)
  ck("G4 the card STAYS in its stage column (Contacted) and carries the 'New message' tag and the blink", cm?.col === "contacted" && /New message/.test(cm.tag) && /\[animation:pulse/.test(cm.cls) && (await bp.locator('[data-column="incoming"]').count()) === 0, card)
  await bp.screenshot({ path: `${SHOTS}/qa-fc-board-tag.png` })

  // ---- 3. the chat: a visible toolbar on hover (emoji, reply, edit, more), text can be selected
  const wp = await open(owner, `/marketing/window/${Lm}?role=seller`)
  await wp.locator('[data-testid^="tab-chat"]').first().click().catch(async () => { await wp.getByText("Chat", { exact: true }).first().click() })
  await wp.getByTestId("lead-chat").waitFor({ timeout: 60000 })
  await wp.waitForTimeout(2500)
  const theirs = wp.getByTestId("talk-msg-theirs").first()
  await theirs.hover()
  ck("G5 hovering a message shows the toolbar: emoji, reply, more (no edit on somebody else's message)", (await wp.getByTestId("talk-tool-emoji").first().isVisible()) && (await wp.getByTestId("talk-tool-reply").first().isVisible()) && (await wp.getByTestId("talk-tool-more").first().isVisible()) && (await wp.getByTestId("talk-tool-edit").count()) === 0)
  ck("G5b the text of a message can be selected with the mouse", (await theirs.evaluate(e => getComputedStyle(e).userSelect)) !== "none")
  // react with a quick emoji
  await wp.getByTestId("talk-tool-emoji").first().click()
  await wp.getByTestId("talk-quick-👍").click()
  let reacts = 0
  for (let i = 0; i < 20; i++) { reacts = (await db.query("select count(*)::int n from marketing_lead_message_reactions where emoji='👍' and message_id in (select id from marketing_lead_messages where lead_id=$1)", [Lm])).rows[0].n; if (reacts === 1) break; await wp.waitForTimeout(500) }
  ck("G6 the quick emoji from the toolbar reacts (one reaction saved)", reacts === 1, reacts)
  await wp.getByTestId("talk-msg-theirs").first().hover()
  await wp.getByTestId("talk-tool-emoji").first().click()
  await wp.getByTestId("talk-emoji-more").click()
  ck("G6b '+' opens the full emoji picker", (await wp.getByTestId("talk-emoji-picker").count()) === 1)
  await wp.getByTestId("talk-tool-emoji").first().click()
  ck("G6c clicking the emoji button again closes the popover (it does not reopen it)", (await wp.getByTestId("talk-emoji-popover").count()) === 0)
  await wp.keyboard.press("Escape")
  // write a message of his own, then edit it from the toolbar
  const box = wp.locator("textarea, [contenteditable=true]").last()
  await box.click(); await box.fill("First wording"); await wp.keyboard.press("Enter")
  await wp.waitForTimeout(2500)
  const mine = wp.getByTestId("talk-msg-mine").last()
  await mine.hover()
  ck("G7 on his own message the toolbar also shows Edit", await wp.getByTestId("talk-tool-edit").last().isVisible())
  await wp.getByTestId("talk-tool-edit").last().click()
  const box2 = wp.locator("textarea, [contenteditable=true]").last()
  await box2.fill("Second wording"); await wp.keyboard.press("Enter")
  let edited = ""
  for (let i = 0; i < 60; i++) { edited = (await db.query("select message from marketing_lead_messages where lead_id=$1 and edited_at is not null order by created_at desc limit 1", [Lm])).rows[0]?.message ?? ""; if (edited === "Second wording") break; await wp.waitForTimeout(500) }
  ck("G7b the edit is saved (and marked edited)", edited === "Second wording", edited)
  await wp.screenshot({ path: `${SHOTS}/qa-fc-chat-toolbar.png` })

  // ---- 4. Mark unread: for him only, from that message on, and the open window does not undo it
  const firstMsg = (await db.query("select id, created_at from marketing_lead_messages where lead_id=$1 and sender_id=$2 order by created_at limit 1", [Lm, ids.admin])).rows[0]
  const posBefore = (await db.query("select last_read_at from marketing_lead_lane_reads where lane='owners' and lead_id=$1 and user_id=$2", [Lm, ids.ownerA])).rows[0]?.last_read_at
  await wp.getByTestId("talk-msg-theirs").first().hover()
  await wp.getByTestId("talk-tool-more").first().click()
  await wp.getByTestId("talk-act-unread").click()
  // the request waits for a refresh already on its way, so on a busy machine it lands a few seconds later: wait for it
  let posAfter: string | undefined
  for (let i = 0; i < 40; i++) { posAfter = (await db.query("select last_read_at from marketing_lead_lane_reads where lane='owners' and lead_id=$1 and user_id=$2", [Lm, ids.ownerA])).rows[0]?.last_read_at; if (posAfter && new Date(posAfter).getTime() < new Date(firstMsg.created_at).getTime()) break; await wp.waitForTimeout(500) }
  ck("G8 'Mark unread' moves HIS read position back to just before that message", !!posAfter && new Date(posAfter).getTime() < new Date(firstMsg.created_at).getTime() && (!posBefore || new Date(posAfter).getTime() < new Date(posBefore).getTime()), { posBefore, posAfter, at: firstMsg.created_at })
  await wp.waitForTimeout(9000)
  const posLater = (await db.query("select last_read_at from marketing_lead_lane_reads where lane='owners' and lead_id=$1 and user_id=$2", [Lm, ids.ownerA])).rows[0]?.last_read_at
  ck("G8b the open window does not read the chat again by itself (the position stays back after the next refreshes)", posLater && new Date(posLater).getTime() === new Date(posAfter).getTime(), { posAfter, posLater })
  const otherPos = (await db.query("select last_read_at from marketing_lead_lane_reads where lane='owners' and lead_id=$1 and user_id=$2", [Lm, ids.admin])).rows[0]?.last_read_at
  ck("G8c nobody else's chat changed (Antonio's own position is untouched)", !otherPos || new Date(otherPos).getTime() >= new Date(firstMsg.created_at).getTime(), otherPos)
  const bp2 = await open(owner, "/marketing/board")
  const cm2 = (await bp2.$$eval('[data-testid="board-card"]', els => els.map(e => ({ id: e.getAttribute("data-lead"), tag: (e.querySelector('[data-testid="card-unread"]')?.textContent ?? "").trim() })))).find(c => c.id === Lm)
  ck("G8d the card shows 'New message' again on his board", /New message/.test(cm2?.tag ?? ""), cm2)
  const badMark = await api(await open(setter, "/marketing/call-list"), "POST", `/api/marketing/chat/${Lm}/unread`, { message_id: firstMsg.id })
  ck("G9 a setter cannot mark unread a message she may not see (404)", badMark.status === 404 || badMark.status === 403, badMark)
  const setterPage = await open(setter, "/marketing/call-list")
  const sChat = await api(setterPage, "GET", `/api/marketing/chat/${Lm}`)
  const hiddenAt = new Date(firstMsg.created_at).getTime()
  const leaked = ((sChat.body?.member_reads ?? []) as Array<{ last_read_at: string }>).some(r => Math.abs(new Date(r.last_read_at).getTime() - (hiddenAt - 1)) < 2)
  ck("G11 the setter is never handed a read position that points at a message she cannot see", sChat.status === 200 || sChat.status === 403 || sChat.status === 404 ? !leaked : false, { status: sChat.status, leaked })

  // ---- 5. Documents: a real Word file opens in the page
  const docPath = process.env.QA_DOCX ?? ""
  if (docPath) {
    await adminP.reload({ waitUntil: "load", timeout: 150000 }).catch(() => undefined)
    await adminP.waitForTimeout(3000)
    await adminP.getByTestId("home-docs-input").setInputFiles(docPath)
    await adminP.getByTestId("home-docs-notice").waitFor({ timeout: 90000 })
    const dp = await open(adminCtx, "/marketing/documents")
    await dp.getByTestId("doc-download").first().waitFor({ timeout: 90000 })
    const row = dp.locator("li", { hasText: ".docx" }).first()
    const href = await row.getByTestId("doc-view").getAttribute("href")
    ck("G10 a Word file has an Open link", !!href && /view=1/.test(href), href)
    const res = await dp.request.get(`${BASE}${href}`)
    const html = await res.text()
    ck("G10b Open shows it as a readable page (script-free, sandboxed), not a download", res.status() === 200 && /text\/html/.test(res.headers()["content-type"] ?? "") && /sandbox/.test(res.headers()["content-security-policy"] ?? "") && /^inline|^$/.test((res.headers()["content-disposition"] ?? "").split(";")[0]) && html.length > 500 && !/<script/i.test(html), { s: res.status(), h: res.headers(), len: html.length })
    await dp.screenshot({ path: `${SHOTS}/qa-fc-documents.png` })
  }

  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })

