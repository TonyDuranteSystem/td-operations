/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, password reset): proves "Forgot password?", the owner's "Reset password" button, the workspace link on the Team page and the
   "Choose a new password" page through the REAL login page, dev server and database (mail is captured by SANDBOX_MODE, nothing leaves the machine).
   Needs: the private stack up (with migration 20261101-1000 applied) and the dev server on :3010 (MFA_GRACE_UNTIL in the future).
   Run: npx tsx scripts/marketing/qa-reset.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const NEW1 = "Brand-new-password-77"
const NEW2 = "Another-new-password-88"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-rs-${k.toLowerCase()}@example.test`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  type AdminApi = { listUsers: (a: object) => Promise<{ data: { users: Array<{ id: string; email?: string }> } }>; deleteUser: (id: string) => Promise<unknown>; createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> }
  const A = (supabaseAdmin as unknown as { auth: { admin: AdminApi } }).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")

  // clean an earlier run (local test database only)
  await db.query("set session_replication_role = replica")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA rs %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_password_resets", "marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-rs-"))) await A.deleteUser(u.id)
  await db.query("delete from sandbox_captured_emails where recipient ilike '%qa-rs-%'")

  const team = (await S.createTeam({ name: `QA rs ${stamp}`, actor: "qa-rs" })).data!
  await S.setTeamStatus(team.id, "active", "qa-rs")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-rs", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  const ids: Record<string, string> = {}
  const mk = async (key: string, role: "owner" | "member", bundle?: string) => {
    const inv = await M.createInvite({ teamId: team.id, email: em(key), memberRole: role, bundle: bundle ?? null, actor: adminActor })
    if (inv.ok === false) throw new Error(`invite ${key}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS })
    if (acc.ok === false) throw new Error(`accept ${key}: ${acc.error}`)
    ids[key] = (await db.query("select id from auth.users where email=$1", [em(key)])).rows[0].id
    await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`, [ids[key]])
  }
  await mk("ownerA", "owner"); await mk("ownerB", "owner"); await mk("setterA", "member", "setter"); await mk("sellerA", "member", "seller"); await mk("pausedA", "member", "setter"); await mk("aleA", "member", "content")
  await db.query("update marketing_team_members set status='paused' where user_id=$1", [ids.pausedA])
  for (const [key, role] of [["admin", "admin"], ["staff", "team"], ["client", "client"]] as const) {
    const r = await A.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }
  for (const uid of Object.values(ids)) for (const k of ["setter", "seller", "content", "analyst", "owner", "generic"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) values ($1,$2,$3,'done') on conflict do nothing", [uid, team.id, k])
  const joined = await M.addAdminAsOwner({ teamId: team.id, admin: { id: ids.admin, email: em("admin") } })
  if (joined.ok === false) throw new Error(`admin join: ${joined.error}`)

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
    await page.close()
    return ctx
  }
  let ipSeq = 10
  const nextIp = () => `10.20.30.${++ipSeq}`
  const anon = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await c.setExtraHTTPHeaders({ "x-forwarded-for": nextIp() }); await c.addCookies([{ name: "tdm_lang", value: "en", domain: new URL(BASE).hostname, path: "/" }]); return c }
  const JSON_FROM = (ip: string = nextIp()) => ({ "Content-Type": "application/json", "x-forwarded-for": ip })
  const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const restLogin = async (email: string, password: string) => { const r = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON_KEY }, body: JSON.stringify({ email, password }) }); return r.status === 200 ? (await r.json()) as { access_token: string; refresh_token: string } : null }
  const restUserStatus = async (access: string) => (await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${access}` } })).status
  const restRefreshStatus = async (refresh: string) => (await fetch(`${SUPA}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { "Content-Type": "application/json", apikey: ANON_KEY }, body: JSON.stringify({ refresh_token: refresh }) })).status
  const metaOf = async (userId: string) => (await db.query("select raw_app_meta_data from auth.users where id=$1", [userId])).rows[0].raw_app_meta_data as Record<string, unknown>
  const passwordWorks = async (email: string, password: string) => {
    const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { "Content-Type": "application/json", apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! }, body: JSON.stringify({ email, password }) })
    return r.status === 200
  }
  const captured = async (email: string) => (await db.query("select recipient, subject, body, links from sandbox_captured_emails where recipient ilike $1 order by created_at desc", [`%${email}%`])).rows
  const linkOf = (row: { links: unknown; body: string }) => {
    const all: string[] = Array.isArray(row.links) ? (row.links as string[]) : (() => { try { return JSON.parse(String(row.links)) } catch { return [] } })()
    return all.find(l => l.includes("/marketing/reset?token=")) ?? /https?:\/\/\S*\/marketing\/reset\?token=[A-Za-z0-9_-]+/.exec(row.body)?.[0] ?? ""
  }
  const rowsFor = async (userId: string) => (await db.query("select * from marketing_password_resets where user_id=$1 order by created_at", [userId])).rows
  const localLink = (link: string) => `${BASE}/marketing/reset?token=${new URL(link).searchParams.get("token")}`

  // ── 1. the login page and the public pages ────────────────────────────────────
  {
    const c = await anon(); const p = await c.newPage()
    await p.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 })
    const link = p.getByRole("link", { name: "Forgot your password?" })
    ck("1 the login page shows a 'Forgot your password?' link", (await link.count()) === 1)
    await link.click(); await p.waitForURL(/\/marketing\/forgot/, { timeout: 60000 })
    ck("2 it opens the Forgot password page without signing in", /\/marketing\/forgot/.test(p.url()) && (await p.locator("#forgot-email").count()) === 1, p.url())
    await p.screenshot({ path: `${SHOTS}/rs-forgot.png` })
    const rp = await c.newPage(); const r = await rp.goto(`${BASE}/marketing/reset?token=${"A".repeat(43)}`, { waitUntil: "networkidle", timeout: 180000 })
    ck("3 the new-password page opens without signing in", r?.status() === 200 && (await rp.locator("#reset-password").count()) === 1, r?.status())
    const bad = await fetch(`${BASE}/api/marketing/forgot`, { method: "POST", headers: JSON_FROM(), body: JSON.stringify({ email: "not an email" }) })
    ck("4 something that is not an email is the only thing refused", bad.status === 400)
    const noTok = await fetch(`${BASE}/api/marketing/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "A".repeat(43), password: NEW1 }) })
    ck("5 a made-up link is refused with the generic answer", noTok.status === 400 && /cannot be used/.test((await noTok.json()).error))
    await c.close()
  }

  // ── 2. Forgot password: the same answer for everyone, an email only for a real member ──
  const answers: string[] = []
  for (const who of ["setterA", "pausedA", "client", "admin", "staff", "nobody"]) {
    const c = await anon(); const p = await c.newPage()
    await p.goto(`${BASE}/marketing/forgot`, { waitUntil: "networkidle", timeout: 180000 })
    await p.fill("#forgot-email", em(who)); await p.click("#forgot-submit")
    await p.waitForSelector("#forgot-answer", { timeout: 60000 })
    answers.push((await p.textContent("#forgot-answer")) ?? "")
    if (who === "setterA") await p.screenshot({ path: `${SHOTS}/rs-forgot-sent.png` })
    await c.close()
  }
  ck("6 a member, a paused member, a client, an admin, a staff login and a stranger all get the SAME answer", answers.every(a => a === answers[0]) && /link to choose a new password is on its way/.test(answers[0]), answers)
  const mailSetter = await captured(em("setterA"))
  ck("7 the member got ONE email, at his own address, in the page's language (English here)", mailSetter.length === 1 && /Choose a new password/i.test(String(mailSetter[0].subject)), mailSetter.map(m => m.subject))
  await fetch(`${BASE}/api/marketing/forgot`, { method: "POST", headers: JSON_FROM(), body: JSON.stringify({ email: em("aleA") }) })
  const mailAle = await captured(em("aleA"))
  ck("7b with no language chosen the email is in Italian (the workspace default)", mailAle.length === 1 && /nuova password/i.test(String(mailAle[0].subject)) && /Ciao/.test(String(mailAle[0].body)), mailAle.map(m => m.subject))
  const otherMails = (await db.query("select recipient from sandbox_captured_emails where recipient ilike '%qa-rs-%' and recipient not ilike $1 and recipient not ilike $2", [`%${em("setterA")}%`, `%${em("aleA")}%`])).rows
  ck("8 nobody else got an email (paused, client, admin, staff, stranger)", otherMails.length === 0, otherMails)
  const setterRows = await rowsFor(ids.setterA)
  const noRows = await Promise.all(["pausedA", "client", "admin", "staff"].map(async k => (await rowsFor(ids[k])).length))
  ck("9 one stored link for the member, none for the others", setterRows.length === 1 && noRows.every(n => n === 0), { setterRows: setterRows.length, noRows })
  const emailLink = linkOf(mailSetter[0])
  const emailToken = new URL(emailLink).searchParams.get("token") ?? ""
  ck("10 only the hash of the link is stored, and it expires within the hour", emailToken.length === 43 && setterRows[0].token_hash !== emailToken && new Date(setterRows[0].expires_at).getTime() - Date.now() < 61 * 60 * 1000, { len: emailToken.length })
  ck("11 the database holds no copy of the raw link", (await db.query("select count(*) from marketing_password_resets where token_hash = $1 or email_lower = $1", [emailToken])).rows[0].count === "0")

  // ── 3. the link: mismatched, short, good; then used up ────────────────────────────
  {
    const c = await anon(); const p = await c.newPage()
    await p.goto(localLink(emailLink), { waitUntil: "networkidle", timeout: 180000 })
    await p.fill("#reset-password", NEW1); await p.fill("#reset-again", NEW1 + "x"); await p.click("#reset-submit")
    await p.waitForSelector('p[role="alert"]', { timeout: 30000 })
    ck("12 two different passwords are refused on the page", /not the same/i.test((await p.textContent('p[role="alert"]')) ?? ""))
    await p.fill("#reset-password", "short"); await p.fill("#reset-again", "short"); await p.click("#reset-submit")
    await p.waitForFunction(() => /at least 12/i.test(document.querySelector('p[role="alert"]')?.textContent ?? ""), null, { timeout: 30000 })
    ck("13 a short password is refused and the link is not used up", (await rowsFor(ids.setterA))[0].used_at === null && (await passwordWorks(em("setterA"), PASS)))
    await p.screenshot({ path: `${SHOTS}/rs-reset-short.png` })
    await p.fill("#reset-password", NEW1); await p.fill("#reset-again", NEW1); await p.click("#reset-submit")
    await p.waitForURL(/\/mfa\/(verify|enroll)/, { timeout: 90000 })
    ck("14 a good password signs him in and lands on the second step (he still needs his code)", /\/mfa\/verify/.test(p.url()), p.url())
    ck("15 the old password stops working, the new one works", !(await passwordWorks(em("setterA"), PASS)) && (await passwordWorks(em("setterA"), NEW1)))
    ck("16 the link is marked used", (await rowsFor(ids.setterA))[0].used_at !== null)
    const setterMeta = await metaOf(ids.setterA)
    ck("16b the reset bumped the remember-this-device version and kept the marketing role", setterMeta.mfa_rd_version === 1 && setterMeta.role === "marketing", setterMeta)
    const again = await c.newPage(); await again.goto(localLink(emailLink), { waitUntil: "networkidle", timeout: 180000 })
    await again.fill("#reset-password", NEW2); await again.fill("#reset-again", NEW2); await again.click("#reset-submit")
    await again.waitForSelector('p[role="alert"]', { timeout: 30000 })
    ck("17 the same link cannot be used a second time", /cannot be used|could not be used/i.test((await again.textContent('p[role="alert"]')) ?? "") && !(await passwordWorks(em("setterA"), NEW2)))
    await c.close()
  }

  // ── 4. the Team page: workspace link + the owner's Reset password ─────────────────
  const ownerCtx = await session(em("ownerA"))
  {
    const p = await ownerCtx.newPage()
    await p.goto(`${BASE}/marketing/team`, { waitUntil: "networkidle", timeout: 180000 })
    const box = p.locator('[data-testid="workspace-link"] input')
    const val = await box.inputValue()
    ck("18 the Team page shows the workspace link, ending in /marketing", /\/marketing$/.test(val) && /^https?:\/\//.test(val), val)
    await p.screenshot({ path: `${SHOTS}/rs-team.png` })
    const rows = p.locator("li", { has: p.locator('[data-testid="reset-password"]') })
    const emailsWithButton = (await rows.allTextContents()).map(t => /qa-rs-[a-z]+@example\.test/.exec(t)?.[0])
    ck("19 an owner sees Reset password for members, not for himself, not for another owner, not for a paused person", emailsWithButton.includes(em("setterA")) && emailsWithButton.includes(em("sellerA")) && !emailsWithButton.includes(em("ownerA")) && !emailsWithButton.includes(em("ownerB")) && !emailsWithButton.includes(em("pausedA")), emailsWithButton)
    await p.locator("li", { hasText: em("sellerA") }).locator('[data-testid="reset-password"]').click()
    await p.waitForSelector('[data-testid="reset-link-card"]', { timeout: 60000 })
    const link = await p.locator('[data-testid="reset-link-card"] input').inputValue()
    ck("20 pressing it shows a one-time link for that person only", /\/marketing\/reset\?token=[A-Za-z0-9_-]{43}$/.test(link) && (await p.textContent('[data-testid="reset-link-card"]'))!.includes(em("sellerA")), link)
    await p.locator('[data-testid="reset-link-card"]').scrollIntoViewIfNeeded(); await p.locator('[data-testid="reset-link-card"]').screenshot({ path: `${SHOTS}/rs-owner-link.png` })
    const sellerRows = await rowsFor(ids.sellerA)
    ck("21 stored with the owner's email as the maker, valid for a day", sellerRows.length === 1 && sellerRows[0].requested_by === em("ownerA") && new Date(sellerRows[0].expires_at).getTime() - Date.now() > 23 * 3600 * 1000)
    // direct call for a team owner by an owner: refused by the server too
    const refuse = await p.evaluate(async (id: string) => { const r = await fetch(`/api/marketing/team/members/${id}/reset`, { method: "POST" }); return { s: r.status, b: await r.json() } }, ids.ownerB)
    ck("22 the server also refuses an owner's link made by another owner", refuse.s === 400 && /Only Antonio/.test(refuse.b.error), refuse)
    const self = await p.evaluate(async (id: string) => { const r = await fetch(`/api/marketing/team/members/${id}/reset`, { method: "POST" }); return r.status }, ids.ownerA)
    ck("23 and a link for yourself", self === 400)
    // a sign-in the seller already has open (old password) - in a browser AND as raw tokens - must be ended by the reset
    const sellerOld = await session(em("sellerA"))
    const oldPage = await sellerOld.newPage()
    await oldPage.goto(`${BASE}/marketing`, { waitUntil: "networkidle", timeout: 180000 })
    ck("23b before the reset his old sign-in opens the workspace", /\/marketing/.test(oldPage.url()) && !/\/login/.test(oldPage.url()), oldPage.url())
    const oldTokens = await restLogin(em("sellerA"), PASS)
    ck("23c and his raw tokens work", !!oldTokens && (await restUserStatus(oldTokens.access_token)) === 200)
    // the seller uses the link
    const c = await anon(); const sp = await c.newPage()
    await sp.goto(`${BASE}/marketing/reset?token=${new URL(link).searchParams.get("token")}`, { waitUntil: "networkidle", timeout: 180000 })
    await sp.fill("#reset-password", NEW2); await sp.fill("#reset-again", NEW2); await sp.click("#reset-submit")
    await sp.waitForURL(/\/mfa\/(verify|enroll)/, { timeout: 90000 })
    ck("24 the seller chooses a password from the owner's link and reaches the second step", await passwordWorks(em("sellerA"), NEW2) && !(await passwordWorks(em("sellerA"), PASS)))
    await oldPage.goto(`${BASE}/marketing`, { waitUntil: "networkidle", timeout: 180000 })
    ck("24b the sign-in he had open before is ended: the old browser is sent to the login page", /\/login/.test(oldPage.url()), oldPage.url())
    ck("24c and the old raw tokens are refused (access AND refresh)", !!oldTokens && (await restUserStatus(oldTokens.access_token)) !== 200 && (await restRefreshStatus(oldTokens.refresh_token)) !== 200)
    const sellerMeta = await metaOf(ids.sellerA)
    ck("24d the owner's-link reset also bumped the remember-this-device version", sellerMeta.mfa_rd_version === 1 && sellerMeta.role === "marketing", sellerMeta)
    await sellerOld.close()
    await c.close()
    // a newer link cancels the older one
    await p.reload({ waitUntil: "networkidle" })
    await p.locator("li", { hasText: em("setterA") }).locator('[data-testid="reset-password"]').click()
    await p.waitForSelector('[data-testid="reset-link-card"]')
    const l1 = await p.locator('[data-testid="reset-link-card"] input').inputValue()
    await p.locator("li", { hasText: em("setterA") }).locator('[data-testid="reset-password"]').click()
    await p.waitForFunction((old: string) => (document.querySelector('[data-testid="reset-link-card"] input') as HTMLInputElement | null)?.value !== old, l1, { timeout: 30000 })
    const open = (await rowsFor(ids.setterA)).filter(r => !r.used_at && !r.revoked_at)
    ck("25 a newer link cancels the older one (one open link per person)", open.length === 1)
    await p.close()
  }

  // ── 5. Antonio (a CRM admin who is a member) can do it for a team owner, never for his own login ──
  const adminCtx = await session(em("admin"))
  {
    const p = await adminCtx.newPage()
    await p.goto(`${BASE}/marketing/team`, { waitUntil: "networkidle", timeout: 180000 })
    const rows = p.locator("li", { has: p.locator('[data-testid="reset-password"]') })
    const emailsWithButton = (await rows.allTextContents()).map(t => /qa-rs-[a-z]+@example\.test/.exec(t)?.[0])
    ck("26 Antonio sees Reset password for the owner too, but not on his own row", emailsWithButton.includes(em("ownerA")) && emailsWithButton.includes(em("ownerB")) && !emailsWithButton.includes(em("admin")), emailsWithButton)
    await p.locator("li", { hasText: em("ownerB") }).locator('[data-testid="reset-password"]').click()
    await p.waitForSelector('[data-testid="reset-link-card"]', { timeout: 60000 })
    ck("27 his link for an owner is made", (await rowsFor(ids.ownerB)).length === 1)
    const selfRes = await p.evaluate(async (id: string) => { const r = await fetch(`/api/marketing/team/members/${id}/reset`, { method: "POST" }); return r.status }, ids.admin)
    ck("28 nobody can make a link for the admin login itself", selfRes === 400 && (await rowsFor(ids.admin)).length === 0)
    await p.close()
  }

  // ── 6. a signed-in marketing person without the team right, and logged-out callers ──
  {
    const r = await fetch(`${BASE}/api/marketing/team/members/${ids.setterA}/reset`, { method: "POST" })
    ck("29 the owner's route is closed to anyone not signed in", r.status === 401 || r.status === 403 || r.status === 307, r.status)
  }

  // ── 6b. after the bug hunt: owner links survive Forgot, bad bodies, the speed bump, and Antonio is told of a problem ──
  {
    const p = await ownerCtx.newPage()
    await p.goto(`${BASE}/marketing/team`, { waitUntil: "networkidle", timeout: 180000 })
    const made = await p.evaluate(async (id: string) => (await fetch(`/api/marketing/team/members/${id}/reset`, { method: "POST" })).json(), ids.aleA)
    const ownerToken = new URL(made.resetUrl).searchParams.get("token") ?? ""
    const mailsBefore = (await captured(em("aleA"))).length
    const f = await fetch(`${BASE}/api/marketing/forgot`, { method: "POST", headers: JSON_FROM(), body: JSON.stringify({ email: em("aleA") }) })
    const openAfter = (await rowsFor(ids.aleA)).filter(r => !r.used_at && !r.revoked_at)
    ck("31 pressing Forgot while the owner's link is open: same answer, NO new email, the owner's link is still the open one", f.status === 200 && (await captured(em("aleA"))).length === mailsBefore && openAfter.length === 1 && openAfter[0].requested_by === em("ownerA"), { s: f.status, open: openAfter.map(r => r.requested_by) })
    const fin = await fetch(`${BASE}/api/marketing/reset`, { method: "POST", headers: JSON_FROM(), body: JSON.stringify({ token: ownerToken, password: NEW1 }) })
    ck("32 and the owner's link still works", fin.status === 200 && (await passwordWorks(em("aleA"), NEW1)), fin.status)
    for (const path of ["forgot", "reset"]) {
      for (const raw of ["null", "[]", "\"text\""]) {
        const r = await fetch(`${BASE}/api/marketing/${path}`, { method: "POST", headers: JSON_FROM(), body: raw })
        ck(`33 ${path} with a body of ${raw} is a normal 400, not a server error`, r.status === 400, r.status)
      }
    }
    const ip = "198.51.100.77"
    const codes: number[] = []
    let retryAfter: string | null = null
    for (let i = 0; i < 7; i++) { const r = await fetch(`${BASE}/api/marketing/forgot`, { method: "POST", headers: JSON_FROM(ip), body: JSON.stringify({ email: "nobody@example.test" }) }); codes.push(r.status); if (r.status === 429) retryAfter = r.headers.get("retry-after") }
    ck("34 one place is slowed down after five requests a minute (matched or not), with a wait time", codes.slice(0, 5).every(c => c === 200) && codes[5] === 429 && codes[6] === 429 && !!retryAfter, { codes, retryAfter })
    const other = await fetch(`${BASE}/api/marketing/forgot`, { method: "POST", headers: JSON_FROM(), body: JSON.stringify({ email: "nobody@example.test" }) })
    ck("34b another place is not slowed down", other.status === 200)
    // Antonio is told (team chat + error list), once per person, in words that say what to do
    // the chat helper imports "server-only" (a Next.js guard that a plain script cannot load): give this one script an empty stand-in
    const Mod = (await import("node:module")).default as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
    const realLoad = Mod._load
    Mod._load = function (this: unknown, request: string, ...rest: unknown[]) { return request === "server-only" ? {} : realLoad.call(this, request, ...rest) }
    const { alertForgotProblem } = await import("@/lib/marketing/reset-alert")
    await db.query("delete from system_errors where route = '/api/marketing/forgot'")
    await db.query("delete from internal_messages where message like '%qa-rs-%pressed%'")
    await alertForgotProblem(em("sellerA"), "the email could not be sent: qa test")
    await alertForgotProblem(em("sellerA"), "the email could not be sent: qa test again")
    const errs = await db.query("select message from system_errors where route = '/api/marketing/forgot'")
    const chat = await db.query("select message from internal_messages where message like '%qa-rs-%pressed%'")
    ck("35 a Forgot problem is recorded and told in the bug channel ONCE, naming the person, the reason and the fix", errs.rows.length === 1 && chat.rows.length === 1 && chat.rows[0].message.includes(em("sellerA")) && /Reset password/.test(chat.rows[0].message) && /qa test/.test(chat.rows[0].message) && !/again/.test(chat.rows[0].message), { errs: errs.rows.length, chat: chat.rows.length })
    await db.query("delete from system_errors where route = '/api/marketing/forgot'")
    await db.query("delete from internal_messages where message like '%qa-rs-%pressed%'")
    await p.close()
  }

  // ── 7. the table never holds a client / staff / admin login's link ───────────────
  const bad = await db.query("select count(*) from marketing_password_resets r join auth.users u on u.id = r.user_id where r.team_id = $1 and coalesce(u.raw_app_meta_data->>'role','') <> 'marketing'", [team.id])
  ck("30 no link exists for a login that is not a marketing login", bad.rows[0].count === "0")

  await browser.close()
  await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
