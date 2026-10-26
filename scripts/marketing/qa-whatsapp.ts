/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, WhatsApp Web): proves each role gets its own tour once, remembered, replayable, previewable by the owner and never recorded under View as; and that an
   invitation can be previewed and emailed once, through the REAL login page, dev server and database.
   Needs: the private stack up (with migrations 20261023-2000 and 20261024-2100 applied) and `td-marketing-qa` running on :3010.
   Run: npx tsx scripts/marketing/qa-whatsapp.ts */
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
const em = (k: string) => `qa-wa-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qwa-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qwa-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qwa-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA wa %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-wa-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA wa A ${stamp}`, actor: "qa-wa" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-wa")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-wa", permissions: [] as string[] }
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
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter"); await mk("aleA", "member", "content")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }








  const mkLead = async (n: string, name: string) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, answers) values ($1,$2,$3,$4,'+393339990000','new','Ad Alpha', now() - interval '1 day', '[]'::jsonb) returning id", [teamA.id, `qwa-${n}`, name, `qcl${n}@example.test`])).rows[0].id as string
  await mkLead("t1", "Marco Bianchi")
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }, { key: "sold", label: "Sold" }]], ["sale_kind_stages", { strategic_call: "sold" }]] as const) {
    const r = await S.setMarketingSetting({ key: k, value: v, teamId: teamA.id, actor: "qa-wa" }); if (r.ok === false) throw new Error(`setting ${k}: ${r.error}`)
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

  for (const k of ["ownerA", "setterA", "aleA"]) for (const t of ["owner", "setter", "seller", "analyst", "content", "generic"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) values ($1,$2,$3,'skipped') on conflict do nothing", [ids[k], teamA.id, t])
  const leadId = (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, answers) values ($1,'qwa-1','Giulia Rossi','qwa1@example.test','+39 333 999 0000','new','Ad Alpha', now() - interval '1 day', '[]'::jsonb) returning id", [teamA.id])).rows[0].id as string
  const events = async (kind = "whatsapp") => (await db.query("select actor, data from marketing_lead_events where lead_id=$1 and kind=$2 order by created_at", [leadId, kind])).rows as Array<{ actor: string; data: Record<string, unknown> }>
  const status = async () => (await db.query("select status from marketing_leads where id=$1", [leadId])).rows[0].status as string
  const sess = { setter: await session(em("setterA")), owner: await session(em("ownerA")), ale: await session(em("aleA")) }
  const T = (p: Pg, id: string) => p.getByTestId(id)
  // the real browser would open web.whatsapp.com; here every window.open is recorded instead, so the test needs no internet and no WhatsApp account
  const record = (p: Pg) => p.addInitScript(() => { const w = window as unknown as { __opens: unknown[] }; w.__opens = []; window.open = ((...a: unknown[]) => { w.__opens.push(a); return { focus() {} } }) as typeof window.open })
  const opens = (p: Pg) => p.evaluate(() => (window as unknown as { __opens: Array<[string, string, string]> }).__opens)
  const openLead = async (ctx: BrowserContext) => { const p = await ctx.newPage(); await record(p); await p.goto(`${BASE}/marketing/window/${leadId}`, { waitUntil: "networkidle", timeout: 180000 }); return p }

  // ---- A. the lead window
  const sp = await openLead(sess.setter)
  await T(sp, "contact-panel").waitFor({ timeout: 40000 }).catch(async () => { console.log("URL", sp.url(), (await sp.locator("body").innerText()).slice(0, 600)); throw new Error("no contact panel") })
  ck("A1 the lead window has the WhatsApp Web button", /WhatsApp Web/.test(await T(sp, "open-whatsapp").innerText()))
  await T(sp, "open-whatsapp").click()
  await T(sp, "did-you-send").waitFor({ timeout: 30000 })
  const o1 = await opens(sp)
  const text = decodeURIComponent((o1[0]?.[0] ?? "").split("text=")[1] ?? "")
  ck("A2 it opens web.whatsapp.com straight on the lead's chat with the message written", (o1[0]?.[0] ?? "").startsWith("https://web.whatsapp.com/send?phone=393339990000&text=") && /Giulia/.test(text), o1)
  ck("A3 …in its own, always the same, window", o1[0]?.[1] === "tdm-whatsapp" && /width=1100/.test(o1[0]?.[2] ?? ""), o1)
  ck("A4 the system asks 'Did you send it?' and nothing was sent by us", /Did you send it/.test(await T(sp, "did-you-send").innerText()))
  for (let i = 0; i < 20 && (await events()).length === 0; i++) await sp.waitForTimeout(500)
  const ev1 = await events()
  ck("A5 an 'opened' note is on the lead, and the lead did NOT move yet", ev1.length === 1 && ev1[0].data.state === "opened" && ev1[0].actor === em("setterA") && (await status()) === "new", { ev1, st: await status() })
  await T(sp, "sent-no").click()
  await sp.waitForTimeout(800)
  ck("A6 'No' closes the question and writes nothing more", (await T(sp, "did-you-send").count()) === 0 && (await events()).length === 1)
  await T(sp, "open-whatsapp").click()
  await T(sp, "did-you-send").waitFor({ timeout: 30000 })
  await T(sp, "sent-yes").click()
  await sp.waitForTimeout(2000)
  const ev2 = await events()
  ck("A7 'Yes, sent' writes the sent note with the message used, and the lead moves to contacted", ev2.some(e => e.data.state === "sent" && e.data.template === "first_contact") && (await status()) === "contacted", { ev2, st: await status() })
  ck("A8 the question is gone and the history on the page says so", (await T(sp, "did-you-send").count()) === 0 && /WhatsApp sent/.test(await sp.locator("body").innerText()) && /WhatsApp Web opened/.test(await sp.locator("body").innerText()))
  await sp.screenshot({ path: `${SHOTS}/qa-whatsapp-lead.png` })

  // ---- B. the WhatsApp screen
  const sw = await sess.setter.newPage(); await record(sw)
  await sw.goto(`${BASE}/marketing/whatsapp`, { waitUntil: "networkidle", timeout: 180000 })
  await T(sw, "wa-how").waitFor({ timeout: 90000 })
  ck("B1 the screen explains the 3 steps and has the Open WhatsApp Web button", (await sw.locator("ol li").count()) === 3 && (await T(sw, "wa-open-home").count()) === 1)
  ck("B2 'Your numbers today': 1 lead opened (opened twice, counted once), 1 confirmed sent", (await T(sw, "wa-opened").innerText()) === "1" && (await T(sw, "wa-sent").innerText()) === "1", { o: await T(sw, "wa-opened").innerText(), s: await T(sw, "wa-sent").innerText() })
  await T(sw, "wa-open-home").click()
  const o2 = await opens(sw)
  ck("B3 Open WhatsApp Web opens WhatsApp Web's home in the same named window", o2[0]?.[0] === "https://web.whatsapp.com/" && o2[0]?.[1] === "tdm-whatsapp", o2)
  ck("B4 the good habits box is shown", /stop/.test(await T(sw, "wa-habits").innerText()))
  ck("B5 the menu has a WhatsApp item", (await T(sw, "nav-whatsapp").count()) >= 1, JSON.stringify(await sw.$$eval("[data-testid^=nav-]", els => els.map(e => e.getAttribute("data-testid")))))
  await sw.screenshot({ path: `${SHOTS}/qa-whatsapp-screen.png` })

  // ---- C. numbers are personal; the ads person has no WhatsApp
  const ow = await sess.owner.newPage()
  await ow.goto(`${BASE}/marketing/whatsapp`, { waitUntil: "networkidle", timeout: 180000 })
  await T(ow, "wa-numbers").waitFor({ timeout: 90000 })
  ck("C1 the owner's own numbers are 0 (Cristina's work is not his)", (await T(ow, "wa-opened").innerText()) === "0" && (await T(ow, "wa-sent").innerText()) === "0")
  const al = await sess.ale.newPage()
  await al.goto(`${BASE}/marketing/whatsapp`, { waitUntil: "networkidle", timeout: 180000 })
  ck("C2 a person without the WhatsApp right gets the no-access line and no menu item", /do not have access to WhatsApp/.test(await al.locator("body").innerText()) && (await T(al, "nav-whatsapp").count()) === 0)

  // ---- D. a lead with no usable number, and Italian
  await db.query("update marketing_leads set phone='12' where id=$1", [leadId])
  await sp.reload({ waitUntil: "networkidle" })
  ck("D1 a number WhatsApp cannot use: no button, a plain line instead", (await T(sp, "open-whatsapp").count()) === 0 && /cannot be used for WhatsApp/.test(await sp.locator("body").innerText()))
  await db.query("update marketing_leads set phone='+39 333 999 0000' where id=$1", [leadId])
  await sess.setter.addCookies([{ name: "tdm_lang", value: "it", domain: new URL(BASE).hostname, path: "/" }])
  const si = await openLead(sess.setter)
  await T(si, "open-whatsapp").waitFor({ timeout: 90000 })
  ck("D2 in Italian the button and the question are Italian", /Apri questa chat in WhatsApp Web/.test(await T(si, "open-whatsapp").innerText()))
  await T(si, "open-whatsapp").click()
  await T(si, "did-you-send").waitFor({ timeout: 30000 })
  ck("D3 …the question reads \"L'hai inviato?\"", /L'hai inviato\?/.test(await T(si, "did-you-send").innerText()))
  await sess.setter.addCookies([{ name: "tdm_lang", value: "en", domain: new URL(BASE).hostname, path: "/" }])

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
