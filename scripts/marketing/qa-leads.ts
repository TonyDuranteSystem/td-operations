/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Slice 1): proves the Meta lead intake end to end against the REAL dev server,
   the REAL database and a FAKE Meta (a tiny local server on :4010) — signed webhook, duplicate delivery, failed fetch then retry by the
   cron, the safety re-read, the existing-client flag, and what each kind of login can and cannot see.
   Needs: the private stack up and `td-marketing-qa-leads` running (port 3011; its env matches the constants below).
   Run: npx tsx scripts/marketing/qa-leads.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import http from "node:http"
import crypto from "node:crypto"
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3011"
const SECRET = "qa-app-secret", VERIFY = "qa-verify-token", TOKEN = "qa-page-token", CRON = "qa-cron-secret"
const PASS = "Qa-leads-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-leads-${k.toLowerCase()}@example.test`

let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
const sign = (body: string) => "sha256=" + crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("hex")
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── the fake Meta ──
const fakeLeads: Record<string, unknown> = {}
const failIds = new Set<string>()
const seen: Array<{ url: string; auth: string | undefined }> = []
let reconcileList: unknown[] = []
const APP_ID = "1828939005203111"
const USER_KEY = "EAAB-qa-personal-key-0123456789abcdef"
const LONG_KEY = "EAAB-qa-long-lasting-key-0123456789ab"
const PAGE_KEY = "EAAB-qa-the-page-own-key-0123456789a"
const EXPIRED_KEY = "EAAB-qa-expired-key-0000000000000000"
let hideMyPage = false
const exchanges: Array<{ method: string; url: string; auth: string | undefined; body: string }> = []
let pageSubscribed = false
let tokenBad = false
const posts: Array<{ url: string; auth: string | undefined; body: string }> = []
const fake = http.createServer((req, res) => {
  seen.push({ url: req.url ?? "", auth: req.headers.authorization })
  const path = (req.url ?? "").split("?")[0]
  const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)) }
  let m: RegExpExecArray | null
  if (tokenBad && /^\/v25\.0\/(me|\d+\/subscribed_apps)$/.test(path)) return send(401, { error: { message: "Error validating access token: Session has expired", code: 190 } })
  const auth = String(req.headers.authorization ?? "")
  if (path === "/v25.0/me") {
    if (auth === `Bearer ${EXPIRED_KEY}`) return send(401, { error: { message: "Error validating access token: Session has expired", code: 190 } })
    if (auth === `Bearer ${USER_KEY}` || auth === `Bearer ${LONG_KEY}`) return send(200, { id: "u9", name: "Tony Durante" })
    return send(200, { id: "111", name: "QA Page" })
  }
  if (path === "/v25.0/me/accounts") {
    if (auth !== `Bearer ${USER_KEY}` && auth !== `Bearer ${LONG_KEY}`) return send(400, { error: { message: "(#100) wrong kind of key", code: 100 } })
    return send(200, { data: hideMyPage ? [{ id: "222", name: "Some Other Page", access_token: "x" }] : [{ id: "111", name: "QA Page", access_token: PAGE_KEY }, { id: "222", name: "Some Other Page", access_token: "x" }] })
  }
  if (path === "/v25.0/oauth/access_token") {
    let body = ""
    req.on("data", c => { body += c })
    req.on("end", () => { exchanges.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body }); send(200, { access_token: LONG_KEY, expires_in: 5184000 }) })
    return
  }
  if ((m = /^\/v25\.0\/(\d+)\/subscribed_apps$/.exec(path))) {
    if (req.method === "POST") {
      let body = ""
      req.on("data", c => { body += c })
      req.on("end", () => { posts.push({ url: req.url ?? "", auth: req.headers.authorization, body }); pageSubscribed = true; send(200, { success: true }) })
      return
    }
    return send(200, { data: pageSubscribed ? [{ id: APP_ID, name: "TD Marketing Leads", subscribed_fields: ["leadgen"] }] : [] })
  }
  if ((m = /^\/v25\.0\/(\d+)\/leadgen_forms$/.exec(path))) return send(200, { data: [{ id: "222", name: "LLC ITA form", status: "ACTIVE" }] })
  if ((m = /^\/v25\.0\/(\d+)\/leads$/.exec(path))) return send(200, { data: reconcileList })
  if ((m = /^\/v25\.0\/(\d+)$/.exec(path))) {
    if (failIds.has(m[1])) return send(500, { error: { message: "Temporary Meta outage" } })
    return fakeLeads[m[1]] ? send(200, fakeLeads[m[1]]) : send(404, { error: { message: "Unsupported get request" } })
  }
  send(404, {})
})

const lead = (id: string, name: string, email: string, phone: string) => ({
  id, created_time: new Date().toISOString().replace("Z", "+0000"), ad_id: "333", ad_name: "Ad Video 1", adset_id: "444", adset_name: "Italiani in Italia",
  campaign_id: "555", campaign_name: "14.10.2026 | LLC ITA | Lead Form", form_id: "222", is_organic: false, platform: "ig",
  field_data: [
    { name: "full_name", values: [name] }, { name: "email", values: [email] }, { name: "phone_number", values: [phone] },
    { name: "hai_già_una_attività", values: ["Sì, in Italia"] }, { name: "quanto_vuoi_investire", values: ["5.000 - 10.000"] },
  ],
})
const hook = (id: string) => JSON.stringify({ object: "page", entry: [{ id: "111", time: 1760000000, changes: [{ field: "leadgen", value: { leadgen_id: id, page_id: "111", form_id: "222", ad_id: "333", adgroup_id: "444", created_time: Math.floor(Date.now() / 1000) } }] }] })

async function post(body: string, sig?: string | null, extra: Record<string, string> = {}) {
  const r = await fetch(`${BASE}/api/webhooks/meta-leads`, { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "x-hub-signature-256": sig } : {}), ...extra }, body })
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, unknown> }
}

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  await new Promise<void>(r => fake.listen(4010, "127.0.0.1", r))
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const A = (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>; listUsers: (a: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown> } } }).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")

  // ── clean up an earlier run (local test database only) ──
  await db.query("set session_replication_role = replica")
  await db.query("delete from marketing_lead_events"); await db.query("delete from marketing_leadgen_events"); await db.query("delete from marketing_leads")
  await db.query("delete from contacts where email like 'qa-leads-%'")
  await db.query("delete from marketing_meta_connection")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-leads-"))) await A.deleteUser(u.id)

  // ── seed: two teams, owners, a setter, a member with no lead access, an admin, a staff login ──
  const teamA = (await S.createTeam({ name: `QA leads A ${stamp}`, actor: "qa-leads" })).data!
  const teamB = (await S.createTeam({ name: `QA leads B ${stamp}`, actor: "qa-leads" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-leads"); await S.setTeamStatus(teamB.id, "active", "qa-leads")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-leads", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  const ids: Record<string, string> = {}
  const mk = async (key: string, team: string, role: "owner" | "member", bundle?: string) => {
    const inv = await M.createInvite({ teamId: team, email: em(key), memberRole: role, bundle: bundle ?? null, actor: adminActor })
    if (inv.ok === false) throw new Error(`invite ${key}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS })
    if (acc.ok === false) throw new Error(`accept ${key}: ${acc.error}`)
    ids[key] = (await db.query("select id from auth.users where email=$1", [em(key)])).rows[0].id
    await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`, [ids[key]])
  }
  await S.setMarketingSetting({ key: "permission_bundles", value: { setter: ["leads.read", "leads.call", "leads.mark", "chat"], noleads: ["chat"] }, actor: "qa-leads", teamId: teamA.id })
  await mk("ownerA", teamA.id, "owner"); await mk("ownerB", teamB.id, "owner"); await mk("setterA", teamA.id, "member", "setter"); await mk("nobodyA", teamA.id, "member", "noleads")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await A.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }
  await S.setMarketingSetting({ key: "lead_intake_team_id", value: teamA.id, actor: "qa-leads" } as never)

  // ═══ PART A — the webhook and the cron, over real HTTP ═══
  let r = await fetch(`${BASE}/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=987654`)
  ck("A1 handshake with our token echoes the challenge", r.status === 200 && (await r.text()) === "987654", r.status)
  r = await fetch(`${BASE}/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)
  ck("A2 handshake with a wrong token is refused", r.status === 403, r.status)
  r = await fetch(`${BASE}/api/webhooks/meta-leads?hub.mode=subscribe&hub.challenge=1`)
  ck("A3 handshake with no token is refused", r.status === 403, r.status)

  const b1 = hook("9001")
  let p = await post(b1)
  ck("A4 a notification with no signature is refused (401) and stores nothing", p.status === 401 && (await db.query("select count(*)::int n from marketing_leadgen_events")).rows[0].n === 0, p)
  p = await post(b1, "sha256=" + "0".repeat(64))
  ck("A5 a wrong signature is refused", p.status === 401, p)
  p = await post(b1 + " ", sign(b1))
  ck("A6 a signature of a different body is refused", p.status === 401, p)

  fakeLeads["9001"] = lead("9001", "Mario Rossi", "mario.qa@example.test", "+39 333 111 2233")
  p = await post(b1, sign(b1))
  ck("A7 a correctly signed notification is accepted and the lead is stored", p.status === 200 && p.json.received === 1 && p.json.stored === 1, p)
  const row = (await db.query("select * from marketing_leads where leadgen_id='9001'")).rows[0]
  ck("A8 the lead has every answer, the campaign, the team and status 'new'", !!row && row.full_name === "Mario Rossi" && row.email === "mario.qa@example.test" && row.phone === "+393331112233" && row.status === "new" && row.team_id === teamA.id && row.campaign_name?.includes("LLC ITA") && Array.isArray(row.answers) && row.answers.length === 5, row)
  const ev1 = (await db.query("select status, lead_id from marketing_leadgen_events where leadgen_id='9001'")).rows[0]
  ck("A9 the notification is recorded as done and linked to the lead", ev1?.status === "done" && ev1?.lead_id === row?.id, ev1)
  ck("A10 the history has a 'received' entry", (await db.query("select kind from marketing_lead_events where lead_id=$1", [row.id])).rows.map(x => x.kind).join() === "received")
  p = await post(b1, sign(b1))
  ck("A11 the same notification delivered again creates no second lead", p.status === 200 && (await db.query("select count(*)::int n from marketing_leads where leadgen_id='9001'")).rows[0].n === 1, p)
  ck("A12 Meta was asked with the token in a header and never in the URL", seen.length > 0 && seen.every(s => s.auth === `Bearer ${TOKEN}` && !/access_token|qa-page-token/.test(s.url)), seen.slice(0, 2))
  p = await post(JSON.stringify({ object: "page", entry: [{ id: "111", changes: [{ field: "feed", value: { item: "post" } }] }] }), sign(JSON.stringify({ object: "page", entry: [{ id: "111", changes: [{ field: "feed", value: { item: "post" } }] }] })))
  ck("A13 a signed notification about something else is accepted and ignored", p.status === 200 && p.json.received === 0, p)
  const big = JSON.stringify({ pad: "x".repeat(1_100_000) })
  p = await post(big, sign(big))
  ck("A14 an oversized body is refused", p.status === 413, p.status)
  const bad = "not json"
  p = await post(bad, sign(bad))
  ck("A15 a signed body that is not JSON is refused (400)", p.status === 400, p)

  // failed fetch -> stored for retry -> the cron stores it
  failIds.add("9002"); fakeLeads["9002"] = lead("9002", "Ana Bianchi", "ana.qa@example.test", "+39 340 5556677")
  const b2 = hook("9002")
  p = await post(b2, sign(b2))
  const ev2 = (await db.query("select status, attempts, last_error from marketing_leadgen_events where leadgen_id='9002'")).rows[0]
  ck("A16 when Meta is down the notification is kept (failed, 1 attempt) and the response is still 200", p.status === 200 && p.json.stored === 0 && ev2?.status === "failed" && ev2?.attempts === 1 && /Meta outage/.test(ev2?.last_error ?? ""), { p: p.json, ev2 })
  ck("A17 no lead exists yet for it", (await db.query("select count(*)::int n from marketing_leads where leadgen_id='9002'")).rows[0].n === 0)
  failIds.delete("9002")
  const cronNo = await fetch(`${BASE}/api/cron/marketing-lead-retry`)
  ck("A18 the retry cron refuses a caller without the secret", cronNo.status === 401, cronNo.status)
  const cronYoung = await (await fetch(`${BASE}/api/cron/marketing-lead-retry`, { headers: { authorization: `Bearer ${CRON}` } })).json() as { ok?: boolean; retry?: { tried: number; stored: number } }
  ck("A19 the cron leaves a very fresh failure alone (retries after 2 minutes, not in a tight loop)", cronYoung.ok === true && cronYoung.retry?.tried === 0, cronYoung)
  await db.query("update marketing_leadgen_events set updated_at = now() - interval '10 minutes' where leadgen_id='9002'")
  const cron1 = await (await fetch(`${BASE}/api/cron/marketing-lead-retry`, { headers: { authorization: `Bearer ${CRON}` } })).json() as { ok?: boolean; retry?: { tried: number; stored: number } }
  ck("A20 once Meta is back, the cron stores the lead", cron1.retry?.stored === 1 && (await db.query("select count(*)::int n from marketing_leads where leadgen_id='9002'")).rows[0].n === 1, cron1)

  // safety re-read: a lead whose notification never arrived
  reconcileList = [lead("9003", "Giulia Verdi", "giulia.qa@example.test", "+39 347 8889900")]
  const cron2 = await (await fetch(`${BASE}/api/cron/marketing-lead-retry`, { headers: { authorization: `Bearer ${CRON}` } })).json() as { ok?: boolean; reconcile?: { stored: number; errors: string[] } }
  const l3 = (await db.query("select l.full_name, e.source from marketing_leads l join marketing_leadgen_events e on e.lead_id = l.id where l.leadgen_id='9003'")).rows[0]
  ck("A21 the safety re-read finds a lead whose notification never came", cron2.reconcile?.stored === 1 && l3?.full_name === "Giulia Verdi" && l3?.source === "reconcile", { cron2, l3 })
  const cron3 = await (await fetch(`${BASE}/api/cron/marketing-lead-retry`, { headers: { authorization: `Bearer ${CRON}` } })).json() as { reconcile?: { stored: number } }
  ck("A22 running it again stores nothing twice", cron3.reconcile?.stored === 0 && (await db.query("select count(*)::int n from marketing_leads")).rows[0].n === 3, cron3)

  // existing client
  await db.query("insert into contacts (full_name, email, phone) values ('QA Existing Client', 'qa-leads-existing@example.test', '+1 727 555 0188')")
  fakeLeads["9004"] = lead("9004", "Existing Person", "QA-Leads-Existing@Example.test", "+39 111 000 9999")
  const b4 = hook("9004")
  p = await post(b4, sign(b4))
  const l4 = (await db.query("select existing_client from marketing_leads where leadgen_id='9004'")).rows[0]
  ck("A23 a lead whose email matches a TD contact is flagged (hint only, never merged)", l4?.existing_client?.matched_on?.includes("email") && l4.existing_client.contact_ids.length === 1, l4)

  // the fallback team rule: no configured team + more than one active team = nobody's yet
  await S.setMarketingSetting({ key: "lead_intake_team_id", value: "", actor: "qa-leads" } as never)
  fakeLeads["9005"] = lead("9005", "No Team Yet", "noteam.qa@example.test", "+39 348 1231234")
  const b5 = hook("9005"); await post(b5, sign(b5))
  ck("A24 with two active teams and none chosen, the lead has no team yet (Antonio assigns)", (await db.query("select team_id from marketing_leads where leadgen_id='9005'")).rows[0]?.team_id === null)
  await db.query("update marketing_teams set status='paused' where id=$1", [teamB.id])
  fakeLeads["9006"] = lead("9006", "Only Team", "onlyteam.qa@example.test", "+39 349 5551212")
  const b6 = hook("9006"); await post(b6, sign(b6))
  ck("A25 with exactly one active team, the lead goes to it", (await db.query("select team_id from marketing_leads where leadgen_id='9006'")).rows[0]?.team_id === teamA.id)
  await db.query("update marketing_teams set status='active' where id=$1", [teamB.id])

  // ═══ PART B — what each login sees, through the real login page ═══
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
  async function session(email: string, lift: boolean): Promise<BrowserContext> {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 })
    await page.waitForTimeout(2500)
    await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', PASS); await page.click('button[type="submit"]')
    const until = Date.now() + 120000
    for (;;) { if ((await ctx.cookies(BASE)).some(c => /^sb-.*-auth-token/.test(c.name)) || Date.now() > until) break; await page.waitForTimeout(500) }
    await page.waitForTimeout(1500)
    if (lift) await liftToAal2(ctx)
    await page.close()
    return ctx
  }
  const view = async (ctx: BrowserContext, path: string) => {
    for (let i = 0; ; i++) {
      try {
        const page = await ctx.newPage()
        const resp = await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 180000 })
        const text = (await page.locator("body").innerText()).slice(0, 4000)
        return { page, status: resp?.status() ?? 0, url: page.url(), text }
      } catch (e) { if (i >= 3) throw e; await sleep(3000) }
    }
  }
  const leadId = (n: string) => db.query("select id from marketing_leads where leadgen_id=$1", [n]).then(x => x.rows[0].id as string)

  const owner = await session(em("ownerA"), true)
  let v = await view(owner, "/marketing")
  ck("B1 the owner's home has an 'Open the leads' button", /Open the leads/.test(v.text), v.text.slice(0, 300)); await v.page.close()
  v = await view(owner, "/marketing/leads")
  ck("B2 the owner sees his team's leads, newest first, with the campaign", v.status === 200 && /Mario Rossi/.test(v.text) && /Ana Bianchi/.test(v.text) && /Giulia Verdi/.test(v.text) && /LLC ITA/.test(v.text), v.text.slice(0, 600))
  ck("B3 the owner does NOT see the lead that has no team", !/No Team Yet/.test(v.text), v.text.slice(0, 400))
  ck("B4 the possible-existing-client lead carries the warning", /existing TD client/.test(v.text), v.text.slice(0, 800))
  await v.page.screenshot({ path: `${SHOTS}/qa-leads-list.png`, fullPage: true }); await v.page.close()
  v = await view(owner, `/marketing/leads/${await leadId("9001")}`)
  ck("B5 the lead page shows every answer in plain words", /Hai già una attività/.test(v.text) && /Sì, in Italia/.test(v.text) && /5\.000 - 10\.000/.test(v.text) && /\+393331112233/.test(v.text) && /Lead arrived from the ad/.test(v.text), v.text.slice(0, 900))
  await v.page.screenshot({ path: `${SHOTS}/qa-leads-detail.png`, fullPage: true }); await v.page.close()
  v = await view(owner, `/marketing/leads/${await leadId("9004")}`)
  ck("B6 the existing-client lead page warns before anyone sells", /existing TD client/.test(v.text) && /Do not cold-sell/.test(v.text), v.text.slice(0, 500)); await v.page.close()

  const ownerB = await session(em("ownerB"), true)
  v = await view(ownerB, "/marketing/leads")
  ck("B7 another team's owner sees none of team A's leads", v.status === 200 && !/Mario Rossi|Ana Bianchi|Giulia Verdi/.test(v.text) && /No leads yet/.test(v.text), v.text.slice(0, 400)); await v.page.close()
  v = await view(ownerB, `/marketing/leads/${await leadId("9001")}`)
  ck("B8 guessing team A's lead address from team B gives 'not found', never the lead", v.status === 404 && !/Mario Rossi/.test(v.text), { s: v.status, t: v.text.slice(0, 200) }); await v.page.close()

  const setter = await session(em("setterA"), true)
  v = await view(setter, "/marketing/leads")
  ck("B9 a setter (bundle with leads.read) sees the team's leads", /Mario Rossi/.test(v.text), v.text.slice(0, 300)); await v.page.close()
  const nobody = await session(em("nobodyA"), true)
  v = await view(nobody, "/marketing/leads")
  ck("B10 a member with no lead access is told so and sees no lead", /do not have access to the leads/i.test(v.text) && !/Mario Rossi/.test(v.text), v.text.slice(0, 300)); await v.page.close()
  v = await view(nobody, `/marketing/leads/${await leadId("9001")}`)
  ck("B11 and cannot open a lead page directly either", !/Mario Rossi/.test(v.text), v.text.slice(0, 200)); await v.page.close()

  const admin = await session(em("admin"), false)
  v = await view(admin, "/marketing-leads")
  ck("B12 Antonio's master page lists every team's leads, including the one with no team", v.status === 200 && /Mario Rossi/.test(v.text) && /No Team Yet/.test(v.text) && /Not assigned/.test(v.text), v.text.slice(0, 700))
  ck("B13 and shows the Meta connection health (secrets as set / not set, never their values)", /Meta connection/.test(v.text) && /App secret: set/.test(v.text) && !/qa-app-secret|qa-page-token|qa-verify-token/.test(v.text), v.text.slice(0, 500))
  await v.page.screenshot({ path: `${SHOTS}/qa-leads-admin.png`, fullPage: true }); await v.page.close()
  const staff = await session(em("staff"), false)
  v = await view(staff, "/marketing-leads")
  ck("B14 a staff login (not admin) is turned away from the master page", !/Mario Rossi/.test(v.text), { u: v.url }); await v.page.close()
  const anon = await browser.newContext()
  const ap = await anon.newPage(); const ar = await ap.goto(`${BASE}/marketing/leads`, { waitUntil: "networkidle", timeout: 180000 })
  ck("B15 nobody signed in is sent to the login", /\/login/.test(ap.url()) && !/Mario Rossi/.test(await ap.locator("body").innerText()), { u: ap.url(), s: ar?.status() })

  // ═══ PART C — Antonio's "is Meta connected?" and "subscribe the Page" buttons ═══
  const postJson = async (ctx: BrowserContext, path: string) => {
    const r = await ctx.request.post(BASE + path, { maxRedirects: 0, timeout: 120000, headers: { accept: "application/json", "sec-fetch-mode": "cors" } })
    return { status: r.status(), json: await r.json().catch(() => ({})) as { ok?: boolean; checks?: Array<{ key: string; status: string; detail: string }>; results?: Array<{ ok: boolean; detail: string }>; error?: string } }
  }
  const stat = (j: { checks?: Array<{ key: string; status: string; detail: string }> }, key: string) => j.checks?.find(c => c.key === key)
  let c = await postJson(staff, "/api/marketing-admin/meta/check")
  ck("C1 staff (not admin) cannot run the Meta check", c.status === 401 || c.status === 403, c)
  c = await postJson(staff, "/api/marketing-admin/meta/subscribe")
  ck("C2 staff cannot subscribe the Page either", c.status === 401 || c.status === 403, c)
  c = await postJson(owner, "/api/marketing-admin/meta/check")
  ck("C3 a marketing owner cannot reach the admin routes", c.status === 401 || c.status === 403, c)
  c = await postJson(admin, "/api/marketing-admin/meta/check")
  ck("C4 before subscribing: the key is accepted and forms are visible, but the Page is NOT subscribed", c.status === 200 && stat(c.json, "token")?.status === "ok" && stat(c.json, "forms_111")?.status === "ok" && stat(c.json, "subscribed_111")?.status === "fail" && c.json.ok === false, c)
  ck("C5 secrets are reported as set / not set, never as values", /Set\./.test(stat(c.json, "app_secret")?.detail ?? "") && !/qa-app-secret|qa-page-token|qa-verify-token/.test(JSON.stringify(c.json)), c)
  c = await postJson(admin, "/api/marketing-admin/meta/subscribe")
  ck("C6 subscribing succeeds for the configured Page", c.status === 200 && c.json.results?.[0]?.ok === true, c)
  ck("C7 Meta got a POST with the field in the body and the key in a header, never in the URL", posts.length === 1 && posts[0].body === "subscribed_fields=leadgen" && posts[0].auth === `Bearer ${TOKEN}` && !/qa-page-token|access_token/.test(posts[0].url), posts)
  c = await postJson(admin, "/api/marketing-admin/meta/check")
  ck("C8 after subscribing everything is green", c.status === 200 && c.json.ok === true && stat(c.json, "subscribed_111")?.status === "ok", c)
  tokenBad = true
  c = await postJson(admin, "/api/marketing-admin/meta/check")
  ck("C9 an expired key is explained in plain words and stops the check", stat(c.json, "token")?.status === "fail" && /expired/.test(stat(c.json, "token")?.detail ?? "") && c.json.ok === false, c)
  c = await postJson(admin, "/api/marketing-admin/meta/subscribe")
  ck("C10 subscribing with an expired key says so instead of pretending", c.json.results?.[0]?.ok === false && /expired/.test(c.json.results?.[0]?.detail ?? ""), c)
  tokenBad = false
  // the real buttons, clicked in the real page
  pageSubscribed = false
  const adminPage = await admin.newPage()
  adminPage.on("dialog", d => d.accept())
  await adminPage.goto(`${BASE}/marketing-leads`, { waitUntil: "networkidle", timeout: 180000 })
  await adminPage.getByRole("button", { name: "Check the Meta connection" }).click()
  await adminPage.getByText("Not fully connected yet.").waitFor({ timeout: 60000 })
  ck("C11 clicking 'Check' shows the problem in plain words", /Not subscribed yet/.test(await adminPage.locator("body").innerText()))
  await adminPage.screenshot({ path: `${SHOTS}/qa-leads-meta-before.png`, fullPage: true })
  await adminPage.getByRole("button", { name: "Subscribe the Page to new leads" }).click()
  await adminPage.getByText("Meta is connected.").waitFor({ timeout: 60000 })
  ck("C12 clicking 'Subscribe' then re-checking shows 'Meta is connected.'", /Subscribed\./.test(await adminPage.locator("body").innerText()) && pageSubscribed)
  await adminPage.screenshot({ path: `${SHOTS}/qa-leads-meta-after.png`, fullPage: true })
  await adminPage.close()

  // ═══ PART D — "Connect Meta": a personal key becomes the Page's own key, stored encrypted ═══
  const postBody = async (ctx: BrowserContext, path: string, body: unknown, contentType = "application/json") => {
    const r = await ctx.request.post(BASE + path, { maxRedirects: 0, timeout: 120000, headers: { accept: "application/json", "sec-fetch-mode": "cors", "content-type": contentType }, data: typeof body === "string" ? body : JSON.stringify(body) })
    return { status: r.status(), text: await r.text() }
  }
  type Rep = { ok?: boolean; steps?: Array<{ key: string; status: string; detail: string }>; error?: string }
  const rep = (t: string): Rep => { try { return JSON.parse(t) as Rep } catch { return {} } }
  const stored = async () => (await db.query("select page_id, page_name, page_key_enc, long_lived, connected_by from marketing_meta_connection")).rows
  const metaCallsBefore = () => seen.length

  let d = await postBody(staff, "/api/marketing-admin/meta/connect", {})
  ck("D1 staff cannot use Connect Meta", d.status === 401 || d.status === 403, d)
  d = await postBody(owner, "/api/marketing-admin/meta/connect", {})
  ck("D2 a marketing owner cannot use Connect Meta", d.status === 401 || d.status === 403, d)
  d = await postBody(admin, "/api/marketing-admin/meta/connect", "userKey=abc", "application/x-www-form-urlencoded")
  ck("D3 a form post (not JSON) is refused: cross-site forms cannot trigger it", d.status === 415, d)
  const before = metaCallsBefore()
  d = await postBody(admin, "/api/marketing-admin/meta/connect", { userKey: "not a key, has spaces!" })
  ck("D4 something that does not look like a key is refused before any Meta call, and is not echoed", d.status === 400 && metaCallsBefore() === before && !/not a key/.test(d.text), d)

  // wrong kind: a personal key whose Pages do not include ours
  hideMyPage = true
  d = await postBody(admin, "/api/marketing-admin/meta/connect", { userKey: USER_KEY })
  let r2 = rep(d.text)
  ck("D5 a personal key that does not manage our Page is refused with the Pages it does manage, and stores nothing", d.status === 200 && r2.ok === false && /does not manage this Page.*Some Other Page/.test(JSON.stringify(r2.steps)) && (await stored()).length === 0, { r2, n: (await stored()).length })
  hideMyPage = false

  // an expired key
  d = await postBody(admin, "/api/marketing-admin/meta/connect", { userKey: EXPIRED_KEY })
  r2 = rep(d.text)
  ck("D6 an expired key is explained in plain words and nothing is stored", r2.ok === false && /invalid or has expired/.test(JSON.stringify(r2.steps)) && (await stored()).length === 0, r2)

  // the real thing
  exchanges.length = 0
  d = await postBody(admin, "/api/marketing-admin/meta/connect", { userKey: USER_KEY })
  r2 = rep(d.text)
  ck("D7 a personal key is turned into the Page's own key: connected", d.status === 200 && r2.ok === true, r2)
  const rows = await stored()
  ck("D8 exactly one row is stored, for our Page, marked long-lasting, with the admin's name on it", rows.length === 1 && rows[0].page_id === "111" && rows[0].long_lived === true && rows[0].connected_by === "qa-leads-admin@example.test", rows)
  ck("D9 the stored value is encrypted: the plain Page key appears nowhere in the table", !!rows[0] && !JSON.stringify(rows).includes(PAGE_KEY) && String(rows[0].page_key_enc).startsWith("v1."), rows[0]?.page_key_enc?.slice(0, 12))
  ck("D10 the report and the response never contain any key", !new RegExp(`${USER_KEY}|${LONG_KEY}|${PAGE_KEY}`).test(d.text), "key found in response")
  ck("D11 the extension was a POST with the app id, secret and key in the body, no Authorization header, nothing in the URL", exchanges.length === 1 && exchanges[0].method === "POST" && exchanges[0].auth === undefined && /client_secret=qa-app-secret/.test(exchanges[0].body) && /fb_exchange_token=/.test(exchanges[0].body) && !/qa-app-secret|fb_exchange_token/.test(exchanges[0].url), exchanges)

  // from now on the stored Page key is the one used
  seen.length = 0
  pageSubscribed = false
  c = await postJson(admin, "/api/marketing-admin/meta/check")
  ck("D12 the check now says where the key comes from (our database, long-lasting)", /Stored safely in our database.*long-lasting/.test(stat(c.json, "page_token")?.detail ?? ""), stat(c.json, "page_token"))
  ck("D13 the check used the stored Page key for the Page, not the Vercel one", seen.some(x => x.url.includes("/subscribed_apps") && x.auth === `Bearer ${PAGE_KEY}`) && !seen.some(x => x.url.includes("/subscribed_apps") && x.auth === `Bearer ${TOKEN}`), seen.map(x => `${x.url.split("?")[0]} ${x.auth?.slice(0, 20)}`))
  fakeLeads["9010"] = lead("9010", "After Connect", "afterconnect.qa@example.test", "+39 331 4445566")
  seen.length = 0
  const b10 = hook("9010"); p = await post(b10, sign(b10))
  ck("D14 a new lead is fetched with the stored Page key", p.status === 200 && seen.some(x => x.url.startsWith("/v25.0/9010") && x.auth === `Bearer ${PAGE_KEY}`), { p, seen: seen.map(x => `${x.url.split("?")[0]} ${x.auth?.slice(0, 20)}`) })

  // connecting again replaces the row (still one per Page)
  d = await postBody(admin, "/api/marketing-admin/meta/connect", { userKey: USER_KEY })
  ck("D15 connecting again keeps exactly one row per Page", rep(d.text).ok === true && (await stored()).length === 1, await stored())

  // the real button in the real page, with the key box
  const connectPage = await admin.newPage()
  await connectPage.goto(`${BASE}/marketing-leads`, { waitUntil: "networkidle", timeout: 180000 })
  await connectPage.getByText("I have a fresh Facebook key to use").click()
  await connectPage.getByPlaceholder(/Paste your Facebook key/).fill(USER_KEY)
  await connectPage.getByRole("button", { name: "Connect Meta" }).click()
  await connectPage.getByText("Connected.", { exact: true }).waitFor({ timeout: 90000 })
  const bodyText = await connectPage.locator("body").innerText()
  ck("D16 clicking 'Connect Meta' with a pasted key shows 'Connected.' in plain words, and the key box is emptied", /does not expire on a clock/.test(bodyText) && (await connectPage.getByPlaceholder(/Paste your Facebook key/).inputValue()) === "", bodyText.slice(0, 400))
  ck("D17 the page never shows any key", !new RegExp(`${USER_KEY}|${LONG_KEY}|${PAGE_KEY}`).test(bodyText), "key on screen")
  await connectPage.screenshot({ path: `${SHOTS}/qa-leads-meta-connect.png`, fullPage: true })
  await connectPage.close()

  await browser.close(); await db.end(); fake.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
