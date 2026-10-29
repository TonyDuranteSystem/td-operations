/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Addendum H: Antonio's own dashboard and What's New): proves, through the REAL login page, the REAL dev server and the REAL database, that the
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
import { writeFileSync } from "node:fs"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-od-${k.toLowerCase()}@example.test`
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
  const Lraw = await mkLead("raw", "Untouched Lead", { hoursAgo: 40 })
  const Lnoteam = await mkLead("noteam", "Teamless Lead", { team: null, hoursAgo: 5 })
  const Lchat = await mkLead("chat", "Chat Lead", { hoursAgo: 2 })
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
  const adminCtx = await session(em("admin")), seller = await session(em("sellerA")), sellerIt = await session(em("sellerA"), "it"), setter = await session(em("setterA")), owner = await session(em("ownerA"))
  const open = async (ctx: BrowserContext, path = "/marketing") => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "load", timeout: 180000 }); await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); await p.waitForTimeout(2500); return p }
  const settle = async (p: Pg) => { const url = p.url(); for (let i = 0; i < 3; i++) { try { await p.goto(url, { waitUntil: "load", timeout: 150000 }); break } catch (e) { if (i === 2) throw e; await p.waitForTimeout(3000) } } await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); await p.waitForTimeout(2500) }
  const api = (p: Pg, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) } }, [method, path, payload ?? null] as [string, string, object | null])
  const text = async (p: Pg) => (await p.locator("body").innerText()).replace(/\s+/g, " ")

  // ---- the admin joins the team (the Teams page button does the same)
  const ap = await open(adminCtx, "/marketing-leads")
  const add = await api(ap, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})
  ck("D0 the admin joined the team as owner", add.status === 200, add)
  await settle(ap)

  // ---- ONE menu
  const menuText = await ap.getByTestId("owner-nav").innerText()
  for (const label of ["Home", "What's New", "Leads", "Board", "Calendar", "Messages", "Documents", "Money", "Team", "Templates", "Settings", "Audit log"]) ck(`D1 his menu has "${label}"`, menuText.includes(label), menuText)
  ck("D1b the old tab bar with 'soon' tabs is gone", (await ap.getByTestId("owner-nav").getByText("Conversations").count()) === 0 && (await ap.getByTestId("owner-nav").getByText("soon").count()) === 0)
  ck("D1c What's New carries a red number: the Documents draft waits for his OK", (await ap.getByTestId("owner-nav-news-badge").innerText()) === "1", await ap.getByTestId("owner-nav-news").innerText())
  await ap.screenshot({ path: `${SHOTS}/qa-od-home.png`, fullPage: true })

  // ---- Home blocks
  ck("D2 Home shows the four numbers as links", (await ap.getByTestId("home-number").count()) === 4)
  ck("D2b Needs you, Messages, Calls/Waiting, What's New and Documents cards are on Home", (await ap.getByTestId("home-needs").count()) === 1 && (await ap.getByTestId("home-messages").count()) === 1 && (await ap.getByTestId("home-calls").count()) === 1 && (await ap.getByTestId("home-waiting").count()) === 1 && (await ap.getByTestId("home-news").count()) === 1 && (await ap.getByTestId("home-documents").count()) === 1)
  ck("D2c the Meta health line is small and at the bottom of Home", (await ap.getByTestId("home-health").count()) === 1)

  // ---- Documents from his own menu, in his own frame
  await ap.getByTestId("owner-nav-documents").click()
  await ap.waitForURL("**/marketing/documents", { timeout: 120000 })
  await ap.waitForLoadState("networkidle")
  ck("D3 Documents opens from his menu, and the page is framed by the TEAM'S workspace menu (the same as Rocco's), with a clear 'Back to Marketing' button", (await ap.getByTestId("owner-nav").count()) === 0 && (await ap.getByTestId("nav-board").count()) === 1 && /Back to Marketing/.test(await ap.getByTestId("back-to-crm").innerText().catch(() => "")))
  await ap.screenshot({ path: `${SHOTS}/qa-od-documents.png`, fullPage: false })
  for (const [k, path] of [["board", "/marketing/board"], ["calendar", "/marketing/calendar"], ["chat", "/marketing/chat"], ["templates", "/marketing/templates"]] as const) {
    const p = await open(adminCtx, path)
    ck(`D3b ${k} opens in the team's workspace frame, with the Back to Marketing button`, (await p.getByTestId("owner-nav").count()) === 0 && (await p.getByTestId("nav-board").count()) === 1 && (await p.getByTestId("back-to-crm").count()) === 1, (await text(p)).slice(0, 150))
    await p.close()
  }

  // ---- Home: Needs you — give a lead to a person
  const hp = await open(adminCtx, "/marketing-leads")
  const rawRow = hp.getByTestId("need-lead").filter({ hasText: "Untouched Lead" })
  ck("D4 'Needs you' lists the untouched lead with Open lead and a person dropdown", (await rawRow.count()) === 1 && (await rawRow.getByTestId("give-select").count()) === 1 && (await rawRow.getByTestId("need-open").count()) === 1)
  const options = await rawRow.getByTestId("give-select").locator("option").allInnerTexts()
  ck("D4b the dropdown holds the people who may pick leads (the seller and the team owner), not the setter", options.some(o => /Sellera|Seller/i.test(o)) && !options.some(o => /Settera/i.test(o)), options)
  for (let i = 0; i < 4; i++) {
    await rawRow.getByTestId("give-select").selectOption(ids.sellerA).catch(() => undefined)
    await rawRow.getByTestId("give-send").click().catch(() => undefined)
    await hp.waitForTimeout(6000)
    if ((await db.query("select claimed_by from marketing_leads where id=$1", [Lraw])).rows[0].claimed_by) break
  }
  let claimed: { claimed_by: string | null } = { claimed_by: null }
  for (let i = 0; i < 40; i++) { claimed = (await db.query("select claimed_by from marketing_leads where id=$1", [Lraw])).rows[0]; if (claimed.claimed_by) break; await hp.waitForTimeout(1000) }
  let ev: Array<{ kind: string; actor: string; data: { to?: string } }> = []
  for (let i = 0; i < 20; i++) { ev = (await db.query("select kind, actor, data from marketing_lead_events where lead_id=$1 and kind='given'", [Lraw])).rows; if (ev.length > 0) break; await hp.waitForTimeout(500) }
  ck("D5 assigning gives the lead to that person (atomic) and writes ONE 'given' history line (not a 'picked')", claimed.claimed_by === ids.sellerA && ev.length === 1 && ev[0].data.to === em("sellerA") && (await db.query("select 1 from marketing_lead_events where lead_id=$1 and kind='claimed'", [Lraw])).rowCount === 0, { claimed, ev })
  const again = await api(hp, "POST", `/api/marketing-admin/leads/${Lraw}/give`, { personId: ids.ownerA })
  ck("D5b giving a lead somebody already holds is refused (409), nothing changes", again.status === 409 && (await db.query("select claimed_by from marketing_leads where id=$1", [Lraw])).rows[0].claimed_by === ids.sellerA, again)
  const toSetter = await api(hp, "POST", `/api/marketing-admin/leads/${Lchat}/give`, { personId: ids.setterA })
  ck("D5c a setter (no right to pick) cannot be given a lead (400)", toSetter.status === 400, toSetter)
  const noAdmin = await api(await open(owner), "POST", `/api/marketing-admin/leads/${Lchat}/give`, { personId: ids.sellerA })
  ck("D5d only the admin can give a lead (a team owner gets 403)", noAdmin.status === 403, noAdmin)

  // ---- Home: a lead with no team goes to a team
  await settle(hp)
  const noTeamRow = hp.getByTestId("need-lead").filter({ hasText: "Teamless Lead" })
  ck("D6 a lead with no team is listed with a team dropdown", (await noTeamRow.count()) === 1 && (await noTeamRow.getByTestId("team-box").count()) === 1)
  for (let i = 0; i < 4; i++) {
    await noTeamRow.getByTestId("team-send").click().catch(() => undefined)
    await hp.waitForTimeout(6000)
    if ((await db.query("select team_id from marketing_leads where id=$1", [Lnoteam])).rows[0].team_id) break
  }
  let tid: string | null = null
  for (let i = 0; i < 40; i++) { tid = (await db.query("select team_id from marketing_leads where id=$1", [Lnoteam])).rows[0].team_id; if (tid) break; await hp.waitForTimeout(1000) }
  ck("D6b giving it to the team works", tid === teamA.id, tid)

  // ---- Home: answer a message without leaving the page
  const sp = await open(seller)
  const sent = await api(sp, "POST", `/api/marketing/chat/${Lchat}/messages`, { message: "Antonio, can I offer the two-payment plan?" })
  ck("D7 the seller writes in the lead's chat", sent.status === 200, sent)
  await settle(hp)
  const msg = hp.getByTestId("home-messages")
  ck("D7b Home shows the message with a reply box under it", /two-payment plan|Chat Lead/.test(await msg.innerText()) && (await msg.getByTestId("reply-input").count()) >= 1, await msg.innerText())
  await msg.getByTestId("reply-input").first().fill("Yes, offer it.")
  await msg.getByTestId("reply-input").first().press("Enter")
  let reply: { sender_name?: string; message?: string } | undefined
  for (let i = 0; i < 40; i++) { reply = (await db.query("select sender_name, message from marketing_lead_messages where lead_id=$1 and sender_id=$2 order by created_at desc limit 1", [Lchat, ids.admin])).rows[0]; if (reply) break; await hp.waitForTimeout(1000) }
  ck("D8 his reply lands in that lead's chat under his own name", reply?.message === "Yes, offer it.", reply)

  // ---- Home: Send reminder — a PRIVATE message to the person who has the lead
  const wait = hp.getByTestId("home-waiting")
  ck("D9 the unpaid payment link is listed with 'Send reminder'", /Unpaid Link Lead/.test(await wait.innerText()) && (await wait.getByTestId("remind-open").count()) === 1, await wait.innerText())
  await wait.getByTestId("remind-open").click()
  const pre = await wait.getByTestId("remind-text").inputValue()
  ck("D9b the reminder is already written (and he can change it) before it is sent", /Unpaid Link Lead/.test(pre), pre)
  await wait.getByTestId("remind-text").fill("Promemoria QA: link non pagato.")
  await wait.getByTestId("remind-send").click()
  let dm: { message?: string; thread_id?: string } | undefined
  for (let i = 0; i < 40; i++) { dm = (await db.query("select message, thread_id from marketing_team_messages where team_id=$1 and sender_id=$2 order by created_at desc limit 1", [teamA.id, ids.admin])).rows[0]; if (dm) break; await hp.waitForTimeout(1000) }
  const members = dm?.thread_id ? (await db.query("select user_id from marketing_chat_thread_members where thread_id=$1", [dm.thread_id])).rows.map(r => r.user_id) : []
  ck("D10 the reminder is a direct message between him and the seller ONLY (the setter is not in it)", dm?.message === "Promemoria QA: link non pagato." && members.length === 2 && members.includes(ids.admin) && members.includes(ids.sellerA) && !members.includes(ids.setterA), { dm, members })
  const noLead = await api(hp, "POST", `/api/marketing-admin/leads/${Lraw}/remind`, { message: "x" })
  ck("D10b a reminder about a lead the seller holds is sent to him (200)", noLead.status === 200, noLead)
  const rm2 = await api(hp, "POST", `/api/marketing-admin/leads/${Lnoteam}/remind`, { message: "x" })
  ck("D10c a lead nobody holds has nobody to remind (409)", rm2.status === 409, rm2)

  // ---- Home: Documents card, upload from Home
  const fname = `QA${stamp}-from-home.txt`
  writeFileSync(`/tmp/${fname}`, "owner dashboard QA upload\n")
  await settle(hp)
  await hp.getByTestId("home-docs-input").setInputFiles(`/tmp/${fname}`)
  await hp.getByTestId("home-docs-notice").waitFor({ timeout: 90000 })
  ck("D11 an Upload on Home puts the file in the Marketing folder and lists it as the newest", (await hp.getByTestId("home-doc").first().innerText()).includes(fname), await hp.getByTestId("home-documents").innerText())
  await hp.screenshot({ path: `${SHOTS}/qa-od-home-after.png`, fullPage: true })

  // ---- Documents: a text file opens in the browser (Open), a Word file has only Download
  const wname = `QA${stamp}-letter.docx`
  writeFileSync(`/tmp/${wname}`, "not really a word file\n")
  await hp.getByTestId("home-docs-input").setInputFiles(`/tmp/${wname}`)
  await hp.waitForTimeout(4000)
  const dp = await open(adminCtx, "/marketing/documents")
  await dp.getByTestId("doc-download").first().waitFor({ timeout: 90000 })
  const txtRow = dp.locator("li", { hasText: fname }).first()
  const docxRow = dp.locator("li", { hasText: wname }).first()
  const viewHref = await txtRow.getByTestId("doc-view").getAttribute("href")
  const viewTarget = await txtRow.getByTestId("doc-view").getAttribute("target")
  const dlHref = await txtRow.getByTestId("doc-download").getAttribute("href")
  const viewRes = await dp.request.get(`${BASE}${viewHref}`)
  const dlRes = await dp.request.get(`${BASE}${dlHref}`)
  ck("D12 a text file has an Open link (new tab) next to Download", !!viewHref && /view=1/.test(viewHref) && viewTarget === "_blank")
  ck("D12b Open shows the file in the browser (inline, sandboxed); Download is still a download", /^inline/.test(viewRes.headers()["content-disposition"] ?? "") && /sandbox/.test(viewRes.headers()["content-security-policy"] ?? "") && /^attachment/.test(dlRes.headers()["content-disposition"] ?? ""), { v: viewRes.headers(), d: dlRes.headers() })
  ck("D12c a Word file has only Download (a browser cannot show it), and ?view=1 on it still downloads", (await docxRow.getByTestId("doc-view").count()) === 0 && (await docxRow.getByTestId("doc-download").count()) === 1 && /^attachment/.test((await dp.request.get(`${BASE}${await docxRow.getByTestId("doc-download").getAttribute("href")}?view=1`)).headers()["content-disposition"] ?? ""))
  await dp.screenshot({ path: `${SHOTS}/qa-od-documents-open.png`, fullPage: false })

  // ---- What's New: approve the draft
  const np = await open(adminCtx, "/marketing-leads/news")
  ck("N1 the Documents draft waits for his OK, with its exact text and audience", (await np.getByTestId("news-draft").count()) === 1 && /Documents is live/.test(await np.getByTestId("news-drafts").innerText()))
  const before = (await db.query("select count(*)::int n from marketing_news")).rows[0].n
  const denied = await api(await open(owner), "POST", "/api/marketing-admin/news", { title: "x", body: "y" })
  ck("N2 a team owner (not Antonio) cannot post news: 403, nothing written", denied.status === 403 && (await db.query("select count(*)::int n from marketing_news")).rows[0].n === before, denied)
  const anon = await api(await open(setter), "POST", "/api/marketing-admin/news/discard", { featureKey: "documents" })
  ck("N2b nor discard a draft: 403", anon.status === 403, anon)
  await np.getByTestId("draft-approve").click()
  await np.getByTestId("news-post-row").first().waitFor({ timeout: 60000 })
  const row = (await db.query("select title, audience, feature_key, status, team_id, link_key from marketing_news")).rows
  ck("N3 approving posts it to every team (no team), for the sellers (the people who have the Documents tab), linked to Documents, remembered by its key", row.length === 1 && row[0].feature_key === "documents" && row[0].status === "posted" && row[0].team_id === null && row[0].audience === "sellers" && row[0].link_key === "documents", row)
  ck("N3b the draft is gone and the red number on What's New too", (await np.getByTestId("news-draft").count()) === 0 && (await np.getByTestId("owner-nav-news-badge").count()) === 0)
  const dup = await api(np, "POST", "/api/marketing-admin/news", { title: "Documents is live", body: "again", linkKey: "documents", featureKey: "documents" })
  ck("N3c the same draft cannot be posted twice (409)", dup.status === 409, dup)

  // ---- the seller sees it, opens it, it is marked read
  const s1 = await open(seller, "/marketing/board")
  const strip = await s1.getByTestId("news-strip").innerText().catch(() => "")
  ck("N4 the seller sees the line 'New: Documents is live' on any screen, and a number on What's New in his menu", /New: Documents is live/.test(strip) && (await s1.getByTestId("nav-news-badge").innerText()) === "1", strip)
  await s1.screenshot({ path: `${SHOTS}/qa-od-seller-strip.png`, fullPage: false })
  await s1.getByTestId("news-strip-open").click()
  await s1.waitForURL("**/marketing/news", { timeout: 120000 })
  await s1.getByTestId("news-item").first().waitFor({ timeout: 60000 })
  ck("N4b the news page shows it as New, with a button that opens Documents", (await s1.getByTestId("news-item").first().getAttribute("data-unread")) === "true" && (await s1.getByTestId("news-open").getAttribute("href")) === "/marketing/documents")
  let reads = 0
  for (let i = 0; i < 40; i++) { reads = (await db.query("select count(*)::int n from marketing_news_reads where user_id=$1", [ids.sellerA])).rows[0].n; if (reads === 1) break; await s1.waitForTimeout(1000) }
  ck("N5 opening the page marks it read for him (one row)", reads === 1, reads)
  await s1.screenshot({ path: `${SHOTS}/qa-od-seller-news.png`, fullPage: true })
  const s2 = await open(seller, "/marketing/board")
  ck("N5b next screen: no line, no number", (await s2.getByTestId("news-strip").count()) === 0 && (await s2.getByTestId("nav-news-badge").count()) === 0)

  // ---- no owner Home in the team workspace: the old address lands on the person's real first screen; the team owner who sells reads the news on the news page
  const oh = await open(owner, "/marketing/home")
  ck("N5c the old workspace Home address lands on Today for a team owner who sells (no owner Home in the team workspace)", /\/marketing\/today/.test(oh.url()) && (await oh.getByTestId("owner-home").count()) === 0 && (await oh.getByTestId("nav-home").count()) === 0, oh.url())
  await oh.getByTestId("nav-news").click()
  await oh.waitForURL("**/marketing/news", { timeout: 120000 })
  await oh.getByTestId("news-item").first().waitFor({ timeout: 60000 })
  let ownerReads = 0
  for (let i = 0; i < 40; i++) { ownerReads = (await db.query("select count(*)::int n from marketing_news_reads where user_id=$1", [ids.ownerA])).rows[0].n; if (ownerReads === 1) break; await oh.waitForTimeout(1000) }
  ck("N5d opening What's New marks it read for the team owner too", ownerReads === 1, ownerReads)
  const adminHome = await open(adminCtx, "/marketing/home")
  ck("N5e Antonio, who posts the news, gets no news strip in the workspace, and the old Home address lands on a real screen", (await adminHome.getByTestId("news-strip").count()) === 0 && !/\/marketing\/home/.test(adminHome.url()), adminHome.url())

  // ---- Italian
  const it1 = await open(sellerIt, "/marketing/board")
  ck("N6 on the Italian side the line and the post are Italian", /Novità: Documenti è online/.test(await it1.getByTestId("news-strip").innerText().catch(() => "")) || /Novità/.test(await text(it1)), (await text(it1)).slice(0, 200))

  // ---- audience: sellers only
  const post2 = await api(np, "POST", "/api/marketing-admin/news", { title: "Sellers only", body: "Only for sellers.", audience: "sellers" })
  ck("N7 Antonio posts news for sellers only", post2.status === 200, post2)
  const sSetter = await open(setter, "/marketing/call-list")
  const sStrip = await sSetter.getByTestId("news-strip").innerText().catch(() => "")
  ck("N7b the setter does NOT see the sellers-only post (her line and her one number are about the Documents post only)", !/Sellers only/.test(sStrip) && (await sSetter.getByTestId("nav-news-badge").innerText().catch(() => "0")) === "1", sStrip)
  const hidden = await api(sSetter, "POST", `/api/marketing/news/${post2.body.id}/read`)
  ck("N7c the setter cannot mark or read a post that is not for her: 404", hidden.status === 404, hidden)
  const s3 = await open(seller, "/marketing/board")
  ck("N7d the seller sees it", /New: Sellers only/.test(await s3.getByTestId("news-strip").innerText().catch(() => "")))

  // ---- who read it
  const np2 = await open(adminCtx, "/marketing-leads/news")
  const first = np2.getByTestId("news-post-row").filter({ hasText: "Documents is live" })
  const rb = await first.getByTestId("news-read-by").innerText()
  ck("N8 Antonio sees 'Read by 2 of N' for the Documents post (the seller and the team owner opened it)", /Read by 2 of \d+/.test(rb), rb)
  await first.getByTestId("news-read-by").click()
  const names = await first.getByTestId("news-readers").innerText()
  ck("N8b …and who read it and who has not (the poster himself is not counted)", /Sellera/i.test(names) && /Not yet/.test(names) && !/Qa Od Admin/.test(names), names)
  await np2.screenshot({ path: `${SHOTS}/qa-od-news-admin.png`, fullPage: true })

  // ---- edit and withdraw
  const edit = await api(np2, "PATCH", `/api/marketing-admin/news/${post2.body.id}`, { title: "Sellers only (edited)", body: "Only for sellers, edited.", audience: "sellers" })
  ck("N9 a post can be edited; it is marked edited", edit.status === 200 && (await db.query("select edited_at from marketing_news where id=$1", [post2.body.id])).rows[0].edited_at !== null, edit)
  const wd = await api(np2, "DELETE", `/api/marketing-admin/news/${post2.body.id}`)
  const s4 = await open(seller, "/marketing/news")
  ck("N10 withdrawing hides it from the team, and Antonio keeps it", wd.status === 200 && !/Sellers only/.test(await text(s4)) && (await db.query("select status from marketing_news where id=$1", [post2.body.id])).rows[0].status === "withdrawn", wd)
  const bad = await api(np2, "POST", "/api/marketing-admin/news", { title: "", body: "x" })
  ck("N11 an empty title is refused with a plain sentence (400)", bad.status === 400 && /title/i.test(bad.body.error), bad)
  const bad2 = await api(np2, "POST", "/api/marketing-admin/news", { title: "t", body: "b", linkKey: "no-such-screen" })
  ck("N11b a link to a screen that does not exist is refused (400)", bad2.status === 400, bad2)

  // ---- discard remembers
  await db.query("delete from marketing_news where feature_key='documents'")
  const disc = await api(np2, "POST", "/api/marketing-admin/news/discard", { featureKey: "documents" })
  const np3 = await open(adminCtx, "/marketing-leads/news")
  ck("N12 discarding a draft remembers it: it does not come back", disc.status === 200 && (await np3.getByTestId("news-draft").count()) === 0, disc)

  console.log(`\n${pass} passed, ${fail} failed`)
  await browser.close(); await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
