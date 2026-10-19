/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa): logs in as EVERY kind of login through the real login page against the
   real middleware (dev server on :3010 started with MFA_GRACE_UNTIL in the future) and checks what each can and cannot reach, plus the
   callers that are not browsers (webhook, cron, connector, health). Needs: the private stack up and `td-marketing-qa` running.
   Run: npx tsx scripts/marketing/qa-p1-logins.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-logins-pass-12345"
const stamp = Date.now()
const em = (k: string) => `qa-login-${k}@example.test`

type Res = { status: number; location: string | null; body: string }
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const A = (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>; listUsers: (o: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown> } } }).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")

  // ── seed one login of each kind (old ones from an earlier run are removed first) ──
  const kinds: Array<{ key: string; role: string | null }> = [
    { key: "admin", role: "admin" }, { key: "team", role: "team" }, { key: "client", role: "client" }, { key: "partner", role: "partner" },
    { key: "weird", role: "wizard" }, { key: "norole", role: null }, { key: "spaced", role: "Client " },
  ]
  const old = (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-login-"))
  for (const u of old) await A.deleteUser(u.id)
  await db.query("delete from marketing_teams where name like 'QA logins %'")
  const ids: Record<string, string> = {}
  for (const k of kinds) {
    const r = await A.createUser({ email: em(k.key), password: PASS, email_confirm: true, ...(k.role ? { app_metadata: { role: k.role } } : {}) })
    if (r.error || !r.data.user) throw new Error(`seed ${k.key}: ${r.error?.message}`)
    ids[k.key] = r.data.user.id
  }
  const team = (await S.createTeam({ name: `QA logins ${stamp}`, actor: "qa-logins" })).data!
  await S.setTeamStatus(team.id, "active", "qa-logins")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-logins", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  for (const key of ["mkt", "mktb"]) {
    const inv = await M.createInvite({ teamId: team.id, email: em(key), memberRole: "owner", actor: adminActor })
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS })
    if (acc.ok === false) throw new Error(`seed ${key}: ${acc.error}`)
    ids[key] = (await db.query("select id from auth.users where email=$1", [em(key)])).rows[0].id
  }
  // "mkt" is an ENROLLED marketing login (a verified second-step factor in the database, and its session is lifted to aal2 below);
  // "mktb" has NO second step set up at all.
  await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
                  values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`, [ids.mkt])
  // the staff login also gets one, so staff are tested the way they really are (enrolled and verified)? No: staff stay un-enrolled to prove the grace period still lets them in.

  const jwtSecret = (() => {
    const c = execSync("docker ps --format '{{.Names}}'").toString().split("\n").find(n => n.startsWith("supabase_auth_tdlocal-claude-circlback"))
    const env = execSync(`docker inspect ${c} --format '{{range .Config.Env}}{{println .}}{{end}}'`).toString()
    return env.split("\n").find(l => l.startsWith("GOTRUE_JWT_SECRET="))!.slice("GOTRUE_JWT_SECRET=".length)
  })()

  const browser = await chromium.launch()

  async function session(email: string, lift?: boolean): Promise<BrowserContext> {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 })
    await page.waitForTimeout(2500) // let the page finish loading its scripts before typing
    await page.fill('input[type="email"]', email)
    await page.fill('input[type="password"]', PASS)
    await page.click('button[type="submit"]')
    // the login is done when the session cookie exists (the page's own redirect can be slow in a busy dev server)
    const until = Date.now() + 120000
    for (;;) {
      const has = (await ctx.cookies(BASE)).some(c => /^sb-.*-auth-token/.test(c.name))
      if (has || Date.now() > until) break
      await page.waitForTimeout(500)
    }
    await page.waitForTimeout(1500)
    if (lift) await liftToAal2(ctx)
    await page.close()
    return ctx
  }

  /** Make this browser's session an aal2 (second step done) session: re-sign the access token with the local secret and aal2 claims. */
  async function liftToAal2(ctx: BrowserContext) {
    const cookies = await ctx.cookies(BASE)
    const parts = cookies.filter(c => /^sb-.*-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => a.name.localeCompare(b.name))
    if (!parts.length) throw new Error("no session cookie")
    const base = parts[0].name.replace(/\.\d+$/, "")
    let raw = parts.map(p => decodeURIComponent(p.value)).join("")
    raw = raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : raw
    const sess = JSON.parse(raw)
    const claims = JSON.parse(Buffer.from(sess.access_token.split(".")[1], "base64url").toString("utf8"))
    claims.aal = "aal2"
    claims.amr = [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }, ...(claims.amr ?? [])]
    const secret = new TextEncoder().encode(jwtSecret)
    sess.access_token = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(secret)
    await db.query("update auth.sessions set aal='aal2' where id=$1", [claims.session_id])
    const value = "base64-" + Buffer.from(JSON.stringify(sess), "utf8").toString("base64url")
    await ctx.clearCookies()
    const url = new URL(BASE)
    await ctx.addCookies([{ name: base, value, domain: url.hostname, path: "/", httpOnly: false, secure: false, sameSite: "Lax" }])
  }

  // a busy dev server sometimes resets a connection while it recompiles: retry that, never a real answer
  const fetchRetry = async (ctx: BrowserContext, path: string, headers: Record<string, string>): Promise<Res> => {
    for (let i = 0; ; i++) {
      try {
        const r = await ctx.request.get(BASE + path, { maxRedirects: 0, timeout: 120000, headers })
        return { status: r.status(), location: r.headers()["location"] ?? null, body: (await r.text()).slice(0, 300) }
      } catch (e) {
        if (i >= 4) throw e
        await new Promise(res => setTimeout(res, 4000))
      }
    }
  }
  const get = (ctx: BrowserContext, path: string) => fetchRetry(ctx, path, { accept: "text/html" })
  const api = (ctx: BrowserContext, path: string) => fetchRetry(ctx, path, { accept: "application/json", "sec-fetch-mode": "cors" })
  const redirectsToLogin = (r: Res) => r.status >= 300 && r.status < 400 && /\/login/.test(r.location ?? "")
  const redirectsTo = (r: Res, p: string) => r.status >= 300 && r.status < 400 && (r.location ?? "").includes(p)

  // ── 1. staff + admin ──
  const adminCtx = await session(em("admin"))
  let r = await get(adminCtx, "/team-management"); ck("1.1 admin reaches an admin-only page", r.status === 200, r)
  r = await api(adminCtx, "/api/marketing-admin/teams"); ck("1.2 admin may use the marketing admin API", r.status === 200, r)
  r = await api(adminCtx, "/api/marketing/me"); ck("1.3 admin is not a marketing login (marketing API refuses)", r.status === 401 || r.status === 403, r)
  const teamCtx = await session(em("team"))
  r = await get(teamCtx, "/"); ck("1.4 staff (team) reach the dashboard (grace period lets an un-enrolled staff login in)", r.status === 200, r)
  r = await get(teamCtx, "/team-management"); ck("1.5 staff cannot open an admin-only page", r.status !== 200, r)
  r = await api(teamCtx, "/api/marketing-admin/teams"); ck("1.6 staff cannot use the marketing admin API", r.status === 401 || r.status === 403, r)
  r = await api(teamCtx, "/api/tasks/open-counts"); ck("1.7 staff still use a normal staff API", r.status === 200, r)

  // ── 2. client ──
  const clientCtx = await session(em("client"))
  r = await get(clientCtx, "/"); ck("2.1 a client sent to the dashboard is bounced to the portal", redirectsTo(r, "/portal"), r)
  r = await api(clientCtx, "/api/tasks/open-counts"); ck("2.2 a client cannot call a staff API", r.status === 403, r)
  r = await api(clientCtx, "/api/team-management"); ck("2.3 a client cannot call an admin API", r.status === 403, r)
  r = await api(clientCtx, "/api/portal/language"); ck("2.4 a client CAN reach the portal API family (not blocked by the new door)", r.status !== 403 || !/ROLE|FORBIDDEN|CLIENT/i.test(r.body), r)
  r = await api(clientCtx, "/api/marketing/me"); ck("2.5 a client cannot use the marketing API", r.status === 401 || r.status === 403, r)

  // ── 3. partner ──
  const partnerCtx = await session(em("partner"))
  r = await get(partnerCtx, "/"); ck("3.1 a partner sent to the dashboard is bounced to the partner area", r.status >= 300 && r.status < 400, r)
  const partnerRefused = (x: Res) => x.status === 401 || x.status === 403 || (x.status >= 300 && x.status < 400 && /\/collab/.test(x.location ?? ""))
  r = await api(partnerCtx, "/api/tasks/open-counts"); ck("3.2 a partner cannot call a staff API (refused or sent back to the partner area)", partnerRefused(r), r)
  r = await api(partnerCtx, "/api/marketing/me"); ck("3.3 a partner cannot use the marketing API (refused or sent back to the partner area)", partnerRefused(r), r)

  // ── 4. odd roles are refused ──
  for (const [key, label] of [["weird", "a made-up role"], ["norole", "no role at all"]] as const) {
    const c = await session(em(key))
    r = await get(c, "/"); ck(`4.${key} ${label}: page refused`, redirectsToLogin(r) || r.status === 403, r)
    r = await api(c, "/api/tasks/open-counts"); ck(`4.${key} ${label}: API refused`, r.status === 403 || r.status === 401, r)
  }
  const spacedCtx = await session(em("spaced"))
  r = await get(spacedCtx, "/"); ck("4.spaced role 'Client ' (capital letter + space) is treated as a client (bounced to the portal), not as staff", redirectsTo(r, "/portal"), r)
  r = await api(spacedCtx, "/api/tasks/open-counts"); ck("4.spaced role 'Client ': a staff API is refused", r.status === 403, r)

  // ── 5. marketing logins ──
  const mktbCtx = await session(em("mktb"))
  r = await get(mktbCtx, "/marketing"); ck("5.1 a marketing login with NO second step is sent to set it up EVEN THOUGH the staff grace period is running", redirectsTo(r, "/mfa/enroll"), r)
  r = await api(mktbCtx, "/api/marketing/me"); ck("5.2 ...and its API calls are refused until then", r.status === 401, r)
  const mktCtx = await session(em("mkt"), true)
  r = await get(mktCtx, "/marketing"); ck("5.3 an enrolled marketing login reaches /marketing", r.status === 200, r)
  r = await get(mktCtx, "/"); ck("5.4 ...and is bounced from the dashboard back to /marketing", redirectsTo(r, "/marketing"), r)
  r = await get(mktCtx, "/team-management"); ck("5.5 ...and from an admin page", r.status !== 200, r)
  r = await api(mktCtx, "/api/tasks/open-counts"); ck("5.6 ...cannot call a staff API", r.status === 403, r)
  r = await api(mktCtx, "/api/team-management"); ck("5.7 ...cannot call an admin API", r.status === 403, r)
  r = await api(mktCtx, "/api/marketing/me"); ck("5.8 ...CAN use its own API", r.status === 200, r)
  r = await api(mktCtx, "/api/marketing-admin/teams"); ck("5.9 ...cannot use Antonio's marketing admin API", r.status === 403, r)

  // ── 6. callers that are not browsers ──
  const plain = async (path: string, init: RequestInit = {}) => {
    const x = await fetch(BASE + path, { redirect: "manual", ...init })
    return { status: x.status, location: x.headers.get("location"), body: (await x.text()).slice(0, 200) } as Res
  }
  r = await plain("/api/health"); ck("6.1 health check is public", r.status === 200, r)
  r = await plain("/api/webhooks/stripe", { method: "POST", body: "{}" }); ck("6.2 the Stripe webhook path is not bounced to login (sandbox mode answers 503 by design; a real deployment answers 401 for a bad signature)", !redirectsToLogin(r) && (r.status === 503 || r.status === 401), r)
  r = await plain("/api/cron/payment-integrity-alarm"); ck("6.3 a cron route is reached and refuses a missing secret itself (not a login redirect)", (r.status === 401 || r.status === 403) && !redirectsToLogin(r), r)
  const key = process.env.TD_MCP_API_KEY
  r = await plain("/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
  ck("6.4 the Claude connector (bearer key) still works", r.status === 200, r)
  r = await plain("/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
  ck("6.5 the connector without the key is refused", r.status === 401 || r.status === 403, r)
  r = await plain("/marketing/accept?token=x"); ck("6.6 the invite page is public", r.status === 200, r)
  r = await plain("/api/marketing/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "x", password: "y" }) })
  ck("6.7 accepting with a made-up token gives one generic refusal", r.status === 400, r)
  r = await plain("/api/tasks/open-counts"); ck("6.8 a signed-out call to a staff API is refused", r.status === 401 || r.status === 403 || redirectsToLogin(r), r)
  r = await plain("/login"); ck("6.9 the login page is public", r.status === 200, r)
  r = await plain("/portal/login"); ck("6.10 the portal login page is public", r.status === 200, r)

  // ── 7. every public path listed in the middleware is still reachable signed out (the matcher now also covers /api/*) ──
  const fs = await import("node:fs")
  const mw = fs.readFileSync("middleware.ts", "utf8")
  const list = mw.slice(mw.indexOf("const PUBLIC_PREFIXES = ["))
  const body = list.slice(0, list.indexOf("\n]"))
  const prefixes = Array.from(body.matchAll(/^\s*'([^']+)',?\s*(?:\/\/.*)?$/gm)).map(m => m[1])
  ck("7.0 the public path list was read from the middleware", prefixes.length > 60, prefixes.length)
  const blocked: Array<{ path: string; status: number; note: string }> = []
  for (const pre of prefixes) {
    if (pre === "/api/webhooks") continue // the sandbox guard answers 503 here by design (checked in 6.2)
    const path = pre.endsWith("/") ? `${pre}qa-check` : pre
    let x: Res
    try { x = await plain(path, { signal: AbortSignal.timeout(90000) }) } catch (e) { blocked.push({ path, status: 0, note: String(e).slice(0, 60) }); continue }
    // the middleware's own bounce is a plain redirect to the login page (no query) or a 401 "session expired"; a route that sends a
    // visitor with a bad link to the login page WITH a message (e.g. /portal/view-as) is the route doing its own job, not a bounce
    const bounced = (x.status >= 300 && x.status < 400 && /^(https?:\/\/[^/]+)?\/(portal\/)?login$/.test(x.location ?? "")) || (x.status === 401 && /SESSION_EXPIRED/.test(x.body))
    if (bounced) blocked.push({ path, status: x.status, note: x.location ?? x.body.slice(0, 60) })
  }
  ck(`7.1 none of the ${prefixes.length} public paths is bounced to login or answered 'session expired' when signed out`, blocked.length === 0, blocked)

  await browser.close()
  // clean up
  for (const id of Object.values(ids)) await A.deleteUser(id).catch(() => undefined)
  await db.query("delete from marketing_teams where id=$1", [team.id])
  console.log(`\n${pass} pass, ${fail} fail`)
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
