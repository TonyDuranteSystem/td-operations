/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa; Rocco through Antonio, 29 Oct 2026: "the setter should not see the link, the payment link, or the paid one"). Through the REAL login, the REAL dev server and the REAL database:
   a SETTER opens a lead whose history holds Rocco's notes, a booking link, a payment link, a payment and a "Paid" stage: she reads her own note and the plain facts, nothing of the rest; the stage shows "With the seller", the stage strip has no Paid / Link sent chip; Rocco still sees everything.
   Needs: the private stack up and `td-marketing-dev` on :3010. Run: npx tsx scripts/marketing/qa-setter-history.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const stamp = Date.now()
const em = (k: string) => `qa-sh-${k.toLowerCase()}@example.test`
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
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA sh %'")).rows.map(x => x.id)
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qsh-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qsh-%'")
  if (oldTeams.length) {
    await db.query("delete from marketing_team_messages where team_id = any($1)", [oldTeams])
    await db.query("delete from marketing_chat_thread_members where thread_id in (select id from marketing_chat_threads where team_id = any($1))", [oldTeams])
    await db.query("delete from marketing_chat_threads where team_id = any($1)", [oldTeams])
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-sh-"))) await A.deleteUser(u.id)
  await db.query("insert into storage.buckets (id, name, public) values ('onboarding-uploads', 'onboarding-uploads', false) on conflict do nothing")

  const teamA = (await S.createTeam({ name: `QA sh A ${stamp}`, actor: "qa-sh" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-sh")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-sh", permissions: [] as string[] }
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
    const r = await A.createUser({ email: em("admin"), password: PASS, email_confirm: true, app_metadata: { role: "admin" }, user_metadata: { full_name: "Qa Om Admin" } })
    if (r.error || !r.data.user) throw new Error(`seed admin: ${r.error?.message}`)
    ids.admin = r.data.user.id
    await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'x')`, [ids.admin])
  }
  for (const uid of Object.values(ids)) for (const k of ["setter", "seller", "content", "analyst", "owner"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) values ($1,$2,$3,'done') on conflict do nothing", [uid, teamA.id, k])
  const mkLead = async (n: string, name: string) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, answers) values ($1,$2,$3,$4,'+393339990000','new','Ad Alpha', now() - interval '2 hours', null, null, '[]'::jsonb) returning id",
      [teamA.id, `qsh-${n}-${stamp}`, name, `${n}@example.test`])).rows[0].id as string

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

  const ev = (lead: string, kind: string, actor: string, data: Record<string, unknown> = {}) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data) values ($1,$2,$3,$4)", [lead, kind, actor, data])
  const L = await mkLead("paid", "Secret Lead Alfa")
  await ev(L, "received", "system")
  await ev(L, "note", em("setterA"), { text: "SETTERNOTE ha detto che richiama" })
  await ev(L, "note", em("ownerA"), { text: "ROCCONOTE sconto possibile tra noi" })
  await ev(L, "booking_link", em("ownerA"), { url: "https://example.test/BOOKLINK", via: "whatsapp" })
  await ev(L, "payment_link_created", "system", { sale_id: "s1" })
  await ev(L, "payment_received", "system", {})
  await ev(L, "status_changed", em("ownerA"), { outcome: "closed", to: "paid_call" })
  await db.query("update marketing_leads set status='paid_call', claimed_by=$2, claimed_by_label='Rocco' where id=$1", [L, ids.ownerA])
  const Q = await mkLead("plain", "Plain Setter Lead")
  await ev(Q, "received", "system")

  const text = async (ctx: BrowserContext, path: string) => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "load", timeout: 180000 }); await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); await p.waitForTimeout(1500); const t = await p.locator("body").innerText(); await p.close(); return t }
  const setterCtx = await session(em("setterA"))
  const sPage = await text(setterCtx, `/marketing/window/${L}`)
  ck("H1 the setter reads her own note", /SETTERNOTE/.test(sPage), sPage.slice(0, 400))
  ck("H2 she does not read Rocco's note", !/ROCCONOTE|sconto possibile/.test(sPage), sPage.slice(0, 400))
  ck("H3 she does not see the booking link", !/BOOKLINK|Booking link sent/i.test(sPage), sPage.slice(0, 400))
  ck("H4 she does not see the payment link, the payment or the pay-out", !/Payment link created|Payment received|paid out|Split applied/i.test(sPage), sPage.slice(0, 400))
  ck("H5 the stage says 'With the seller', never Paid", /With the seller/.test(sPage) && !/\bPaid\b|Paid call/.test(sPage), sPage.slice(0, 600))
  const sList = await text(setterCtx, "/marketing/leads")
  ck("H6 the Leads list shows the lead with the seller and no Paid chip", /Secret Lead Alfa/.test(sList) && /With the seller/.test(sList) && !/Paid call|Link sent/.test(sList), sList.slice(0, 900))
  const sFilter = await text(setterCtx, "/marketing/leads?stage=paid_call")
  ck("H7 asking for the Paid stage by address shows her everything, not a Paid list", /Plain Setter Lead/.test(sFilter) && /Secret Lead Alfa/.test(sFilter), sFilter.slice(0, 300))
  const rocco = await session(em("ownerA"))
  const rPage = await text(rocco, `/marketing/window/${L}`)
  ck("H8 Rocco still sees every line", /ROCCONOTE/.test(rPage) && /SETTERNOTE/.test(rPage) && /Payment received/.test(rPage) && /BOOKLINK/.test(rPage), rPage.slice(0, 400))

  console.log(`\n${pass} passed, ${fail} failed`)
  await browser.close()
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
