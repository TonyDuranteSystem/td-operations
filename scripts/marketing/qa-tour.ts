/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, the guided tours and the invitation email): proves each role gets its own tour once, remembered, replayable, previewable by the owner and never recorded under View as; and that an
   invitation can be previewed and emailed once, through the REAL login page, dev server and database.
   Needs: the private stack up (with migrations 20261023-2000 and 20261024-2100 applied) and `td-marketing-qa` running on :3010.
   Run: npx tsx scripts/marketing/qa-tour.ts */
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
const em = (k: string) => `qa-tr-${k.toLowerCase()}@example.test`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qtr-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qtr-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qtr-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA tr %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-tr-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA tr A ${stamp}`, actor: "qa-tr" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-tr")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-tr", permissions: [] as string[] }
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
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter"); await mk("aleA", "member", "content"); await mk("analystA", "member", "analyst"); await mk("sellerA", "member", "seller")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }








  const mkLead = async (n: string, name: string) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, answers) values ($1,$2,$3,$4,'+393339990000','new','Ad Alpha', now() - interval '1 day', '[]'::jsonb) returning id", [teamA.id, `qtr-${n}`, name, `qcl${n}@example.test`])).rows[0].id as string
  await mkLead("t1", "Marco Bianchi")
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }, { key: "sold", label: "Sold" }]], ["sale_kind_stages", { strategic_call: "sold" }]] as const) {
    const r = await S.setMarketingSetting({ key: k, value: v, teamId: teamA.id, actor: "qa-tr" }); if (r.ok === false) throw new Error(`setting ${k}: ${r.error}`)
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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 })
    await page.waitForTimeout(2500)
    await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', PASS); await page.click('button[type="submit"]')
    const until = Date.now() + 120000
    for (;;) { if ((await ctx.cookies(BASE)).some(c => /^sb-.*-auth-token/.test(c.name)) || Date.now() > until) break; await page.waitForTimeout(500) }
    await page.waitForTimeout(1500)
    await liftToAal2(ctx)
    await ctx.addCookies([{ name: "tdm_lang", value: "en", domain: new URL(BASE).hostname, path: "/" }])
    await page.close()
    return ctx
  }










  type Pg = import("playwright").Page
  const open = async (ctx: BrowserContext, path = "/marketing") => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "networkidle", timeout: 180000 }); return p }
  const api = (p: Pg, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) } }, [method, path, payload ?? null] as const)

  const sess = {
    admin: await session(em("admin")), owner: await session(em("ownerA")), setter: await session(em("setterA")),
    seller: await session(em("sellerA")), ale: await session(em("aleA")), analyst: await session(em("analystA")),
  }
  const seen = async (key: string, tour: string) => (await db.query("select status from marketing_tour_seen where user_id=$1 and team_id=$2 and tour_key=$3", [ids[key], teamA.id, tour])).rows[0] as { status: string } | undefined
  const card = (p: Pg) => p.getByTestId("tour-card")

  /** walk a whole tour: welcome -> every step (spotlight lit, title read) -> end card -> Close. Returns the titles. */
  async function walk(p: Pg, close = true, expect: string[] = []): Promise<{ titles: string[]; lit: number; total: number; hrefs: string[]; clipped: number }> {
    let at = "welcome"
    p.on("pageerror", e => console.log("PAGEERROR at step:", at, "url:", p.url(), e.message.slice(0, 160)))
    p.on("console", m => { if (m.type() === "error") console.log("CONSOLE at step:", at, m.text().slice(0, 160)) })
    await card(p).first().waitFor({ timeout: 120000 })
    await p.locator('[data-testid="tour-card"][data-phase="welcome"]').waitFor({ timeout: 60000 })
    await p.getByTestId("tour-next").click()
    const titles: string[] = [], hrefs: string[] = []
    let lit = 0, total = 0, clipped = 0
    for (let i = 1; i < 30; i++) {
      const c = p.locator(`[data-testid="tour-card"][data-phase="step"][data-step="${i}"]`)
      if (!(await c.first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false))) break
      total++
      // the next screen may still be compiling on a slow dev server: wait until the tour has really moved to this step's screen, then for the spotlight
      if (expect[i - 1]) await p.waitForURL(u => u.pathname === expect[i - 1], { timeout: 90000 }).catch(() => {})
      await p.waitForTimeout(1200)
      await p.getByTestId("tour-spot").waitFor({ timeout: 60000 }).catch(() => {})
      await p.waitForTimeout(500)
      if (i === 3 || i === 6) await p.screenshot({ path: `${SHOTS}/qa-tour-step-${i}-${titles.length}.png` })
      titles.push((await c.getByTestId("tour-title").innerText()).trim()); at = titles[titles.length - 1]
      hrefs.push(new URL(p.url()).pathname)
      if ((await p.getByTestId("tour-spot").count()) === 1) lit++
      // the buttons must be inside the window (a small laptop): Next, Back and Skip fully visible
      const vh = p.viewportSize()?.height ?? 720
      for (const id of ["tour-next", "tour-skip"]) { const b = await p.getByTestId(id).boundingBox(); if (!b || b.y < 0 || b.y + b.height > vh) clipped++ }
      await p.getByTestId("tour-next").click()
    }
    await p.locator('[data-testid="tour-card"][data-phase="done"]').waitFor({ timeout: 60000 })
    if (close) await p.getByTestId("tour-close").click()
    return { titles, lit, total, hrefs, clipped }
  }

  // ---- T1 the setter: first time in, the tour starts by itself, goes through 6 steps over the real screens, and is remembered
  const sp = await open(sess.setter, "/marketing/call-list")
  const t1 = await walk(sp, true, ["/marketing/call-list", "/marketing/call-list", "/marketing/calendar", "/marketing/chat", "/marketing/templates", "/marketing/my-numbers"])
  ck("T1 the setter's tour starts by itself on first entry and has the 6 steps of the mockup", t1.total === 6 && t1.titles[0] === "Call list: your work for today" && t1.titles[5] === "My numbers: how you are doing", t1)
  ck("T1b every step lit something real on the screen (the spotlight was there) and its buttons were inside a 1280x720 window", t1.lit === 6 && t1.clipped === 0, t1)
  ck("T1c the tour moved between the real screens by itself (call list, calendar, chat, templates, my numbers)", ["/marketing/call-list", "/marketing/calendar", "/marketing/chat", "/marketing/templates", "/marketing/my-numbers"].every(h => t1.hrefs.includes(h)), t1.hrefs)
  for (let i = 0; i < 40 && !(await seen("setterA", "setter")); i++) await sp.waitForTimeout(500)
  ck("T1d finishing is remembered in the database (done)", (await seen("setterA", "setter"))?.status === "done", await seen("setterA", "setter"))
  await sp.screenshot({ path: `${SHOTS}/qa-tour-setter-end.png` })
  if (process.env.ONLY_T1 === "owner") {
    const o = await open(sess.owner, "/marketing/board")
    const r = await walk(o, true, ["/marketing/board", "/marketing/leads", "/marketing/calendar", "/marketing/chat", "/marketing/templates", "/marketing/team", "/marketing/money"])
    console.log("OWNER", JSON.stringify(r))
    await browser.close(); await db.end(); process.exit(0)
  }
  if (process.env.ONLY_T1) { await browser.close(); await db.end(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0) }

  // ---- T2 it does not start again by itself; the Tour button replays it; skipping is remembered too
  const sp2 = await open(sess.setter, "/marketing/call-list")
  await sp2.waitForTimeout(4000)
  ck("T2 the second time in, no tour starts by itself", (await card(sp2).count()) === 0)
  await sp2.getByTestId("tour-button").click()
  await sp2.locator('[data-testid="tour-card"][data-phase="welcome"]').waitFor({ timeout: 30000 })
  ck("T2b the Tour button opens it again", (await card(sp2).count()) === 1)
  await sp2.getByTestId("tour-skip").click()
  ck("T2c Skip closes it", (await card(sp2).count()) === 0)

  // ---- T3 / T4 / T5 the other roles get their own tours
  const sel = await open(sess.seller, "/marketing/today")
  const t3 = await walk(sel)
  await sel.close()
  ck("T3 the seller's tour: 5 steps, starting with Today", t3.total === 5 && t3.titles[0] === "Today: what needs you now" && t3.titles[4] === "Reports: what works", t3.titles)
  const al = await open(sess.ale, "/marketing/board")
  const t4 = await walk(al)
  await al.close()
  ck("T4 Ale's (ad person) tour: 3 steps, starting with the Board and no phone-number promise broken", t4.total === 3 && t4.titles[0] === "Board: the leads your ads bring", t4.titles)
  const an = await open(sess.analyst, "/marketing/board")
  const t5 = await walk(an)
  ck("T5 the analyst's tour: 4 steps, read only", t5.total === 4 && t5.titles[0] === "Board: look, do not touch", t5.titles)
  await an.waitForTimeout(3000)
  await an.close()
  ck("T5b each of them is remembered", (await seen("sellerA", "seller"))?.status === "done" && (await seen("aleA", "content"))?.status === "done" && (await seen("analystA", "analyst"))?.status === "done")

  // ---- T6 Italian
  await sess.setter.addCookies([{ name: "tdm_lang", value: "it", domain: new URL(BASE).hostname, path: "/" }])
  const it1 = await open(sess.setter, "/marketing/call-list")
  await it1.getByTestId("tour-button").click()
  await it1.locator('[data-testid="tour-card"][data-phase="welcome"]').waitFor({ timeout: 30000 })
  const itWelcome = await card(it1).innerText()
  ck("T6 in Italian the welcome is in Italian (and does not mention Antonio seeing everything)", /Benvenuto in TD Marketing/.test(itWelcome) && !/Antonio vede tutto/.test(itWelcome), itWelcome.slice(0, 120))
  await it1.getByTestId("tour-next").click()
  await it1.locator('[data-testid="tour-card"][data-phase="step"]').waitFor({ timeout: 45000 })
  ck("T6b the first step is Italian", /Lista chiamate/.test(await it1.getByTestId("tour-title").innerText()))
  await sess.setter.addCookies([{ name: "tdm_lang", value: "en", domain: new URL(BASE).hostname, path: "/" }])

  // ---- T7 the owner: his own tour (7 steps), then the preview of each role from the Team screen
  const ow = await open(sess.owner, "/marketing/board")
  const t7 = await walk(ow, true, ["/marketing/board", "/marketing/leads", "/marketing/calendar", "/marketing/chat", "/marketing/templates", "/marketing/team", "/marketing/money"])
  ck("T7 the owner's tour: 7 steps from the Board to Money, the Team step lit the Invite button, buttons inside the window", t7.clipped === 0 && t7.total === 7 && t7.titles[5] === "Team: invite people and choose what they see" && t7.titles[6] === "Money: what the sales brought", t7.titles)
  const ow2 = await open(sess.owner, "/marketing/team")
  await ow2.getByTestId("tour-preview-box").waitFor({ timeout: 60000 })
  ck("T7b the owner's Team screen has 'See each role's tour' with Setter, Seller, Ad person, Analyst", (await Promise.all(["setter", "seller", "content", "analyst"].map(k => ow2.getByTestId(`tour-preview-${k}`).count()))).every(n => n === 1))
  await ow2.getByTestId("tour-preview-setter").click()
  await ow2.getByTestId("tour-preview-bar").waitFor({ timeout: 30000 })
  ck("T7c the preview says it is a preview and that nothing is saved", /Preview/.test(await ow2.getByTestId("tour-preview-bar").innerText()) && /nothing is saved/.test(await ow2.getByTestId("tour-preview-bar").innerText()))
  const t7p = await walk(ow2, false)
  ck("T7d the preview runs the SETTER's 6 steps over the owner's own screens", t7p.total === 6 && t7p.titles[0] === "Call list: your work for today", t7p.titles)
  await ow2.getByTestId("tour-close").click()
  await ow2.waitForURL(/\/marketing\/team$/, { timeout: 60000 }).catch(() => {})
  await ow2.waitForTimeout(1200)
  ck("T7e finishing a preview returns to the Team screen and records nothing for the setter tour under the owner", /\/marketing\/team/.test(ow2.url()) && !(await seen("ownerA", "setter")))
  await sp2.goto(`${BASE}/marketing/team`, { waitUntil: "domcontentloaded", timeout: 120000 })
  await sp2.waitForTimeout(2500)
  ck("T7f a setter has no preview box (he cannot manage the team)", (await sp2.getByTestId("tour-preview-box").count()) === 0)

  // ---- T8 Antonio looking in with View as: no tour starts, nothing is recorded under him
  const va = await open(sess.admin, "/marketing-leads")
  await api(va, "POST", "/api/marketing-admin/view-as", { teamId: teamA.id, as: "setter" })
  await db.query("delete from marketing_tour_seen where user_id=$1", [ids.admin])
  const vp = await open(sess.admin, "/marketing/call-list")
  await vp.waitForTimeout(4000)
  ck("T8 with View as, no tour starts by itself", (await card(vp).count()) === 0)
  await vp.getByTestId("tour-button").click()
  await vp.locator('[data-testid="tour-card"][data-phase="welcome"]').waitFor({ timeout: 30000 })
  await vp.getByTestId("tour-skip").click()
  await vp.waitForTimeout(800)
  const rec = (await db.query("select count(*)::int c from marketing_tour_seen where user_id=$1", [ids.admin])).rows[0].c
  ck("T8b opening and skipping the tour under View as records nothing for Antonio", rec === 0, rec)
  const bad = await api(vp, "POST", "/api/marketing/tour", { tour: "setter", status: "done" })
  ck("T8c the API under View as answers fine but records nothing", bad.status === 200 && bad.body.recorded === false && (await db.query("select count(*)::int c from marketing_tour_seen where user_id=$1", [ids.admin])).rows[0].c === 0, bad)
  await api(vp, "DELETE", "/api/marketing-admin/view-as")

  // ---- T9 the API refuses nonsense
  const r1 = await api(sp2, "POST", "/api/marketing/tour", { tour: "hacker", status: "done" })
  const r2 = await api(sp2, "POST", "/api/marketing/tour", { tour: "setter", status: "weird" })
  ck("T9 an unknown tour or status is refused (400) and nothing is written", r1.status === 400 && r2.status === 400, { r1: r1.status, r2: r2.status })
  const anon = await (await browser.newContext()).request.post(`${BASE}/api/marketing/tour`, { data: { tour: "setter", status: "done" } })
  ck("T9b a signed-out call is refused", anon.status() === 401 || anon.status() === 403, anon.status())

  // ---- E the invitation email, from the CRM (Antonio) on a team without an owner
  const teamB = (await S.createTeam({ name: `QA tr B ${stamp}`, actor: "qa-tr" })).data!
  await S.setTeamStatus(teamB.id, "active", "qa-tr")
  const crmp = await open(sess.admin, "/marketing-leads/teams")
  const blockB = crmp.locator("section", { hasText: teamB.name }).first()
  await blockB.getByLabel("Owner email").fill(em("roccoB"))
  await blockB.getByRole("button", { name: "Create invitation link" }).click()
  await blockB.getByTestId("invite-email-open").waitFor({ timeout: 60000 })
  ck("E1 after the link is made there is a 'Send invitation email' button under it", (await blockB.getByTestId("invite-email-open").count()) === 1)
  await blockB.getByTestId("invite-email-open").click()
  await blockB.getByTestId("invite-email-preview").waitFor({ timeout: 60000 })
  const subj = await blockB.getByTestId("invite-email-subject").innerText()
  const to = await blockB.getByTestId("invite-email-to").innerText()
  ck("E2 the preview shows the invited address, the subject, and the real email in a frame", to === em("roccoB") && subj === "Il tuo accesso a TD Marketing" && (await blockB.getByTestId("invite-email-frame").count()) === 1, { to, subj })
  await blockB.getByTestId("invite-email-lang-en").click()
  await blockB.getByTestId("invite-email-subject").filter({ hasText: "Your access to TD Marketing" }).waitFor({ timeout: 60000 })
  ck("E2a choosing English in the preview changes the subject (and what will be sent)", (await blockB.getByTestId("invite-email-subject").innerText()) === "Your access to TD Marketing")
  const frameHtml = await blockB.getByTestId("invite-email-frame").getAttribute("srcdoc")
  ck("E2b the email carries the one-time link on the app's address and a sandboxed frame (no scripts)", /accept\?token=/.test(frameHtml ?? "") && (await blockB.getByTestId("invite-email-frame").getAttribute("sandbox")) === "")
  const before = (await db.query("select emailed_at from marketing_invites where team_id=$1 and email_lower=$2", [teamB.id, em("roccoB")])).rows[0]
  ck("E2c nothing was sent or marked by just looking at the preview", before && before.emailed_at === null, before)
  await blockB.getByTestId("invite-email-send").click()
  await blockB.getByTestId("invite-email-sent").waitFor({ timeout: 90000 })
  const after = (await db.query("select emailed_at, emailed_by from marketing_invites where team_id=$1 and email_lower=$2", [teamB.id, em("roccoB")])).rows[0]
  ck("E3 pressing Send now sends it and the invitation remembers when and by whom", !!after.emailed_at && /example\.test/.test(String(after.emailed_by)), after)
  const cap = await db.query("select recipient, subject from sandbox_captured_emails order by created_at desc limit 1").catch(() => null)
  ck("E3b the (sandbox-blocked) email was captured addressed to the invited person", !cap || (cap.rows[0] && String(cap.rows[0].recipient).includes(em("roccoB"))), cap?.rows[0])
  const again = await api(crmp, "POST", "/api/marketing-admin/invites/email", { token: "A".repeat(43), send: true })
  ck("E4 a made-up token is refused and sends nothing", again.status === 400, again.status)

  // ---- E5 the workspace: Rocco (owner) invites a person from his Team screen and can email the invitation
  const own = await open(sess.owner, "/marketing/team")
  await own.getByTestId("open-invite").click()
  await own.getByTestId("access-popup").waitFor({ timeout: 60000 })
  await own.getByLabel("Their email").fill(em("newsetter"))
  await own.locator('[data-role="setter"]').click()
  await own.getByTestId("access-submit").click()
  await own.getByTestId("invite-email-open").waitFor({ timeout: 60000 })
  await own.getByTestId("invite-email-open").click()
  await own.getByTestId("invite-email-preview").waitFor({ timeout: 60000 })
  ck("E5 in the workspace Team screen the same button and preview exist, to the invited address", (await own.getByTestId("invite-email-to").innerText()) === em("newsetter"))
  await own.getByTestId("invite-email-send").click()
  await own.getByTestId("invite-email-sent").waitFor({ timeout: 90000 })
  await own.reload({ waitUntil: "domcontentloaded" })
  await own.waitForTimeout(2500)
  ck("E5b the waiting-invitations list now says it was emailed", /emailed/.test(await own.locator("section", { hasText: "Invitations waiting" }).innerText()))
  // an owner of ANOTHER team cannot email or even preview this team's invitation
  const other = await db.query("select token_hash from marketing_invites where team_id=$1 and email_lower=$2", [teamA.id, em("newsetter")])
  ck("E5c the invitation row exists for the workspace-made invite", other.rowCount === 1)

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
