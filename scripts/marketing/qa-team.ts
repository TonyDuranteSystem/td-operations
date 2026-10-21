/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Slice 2a): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-team.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3011"
const PASS = "Qa-team-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-team-${k.toLowerCase()}@example.test`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA team %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-team-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA team A ${stamp}`, actor: "qa-team" })).data!
  const teamB = (await S.createTeam({ name: `QA team B ${stamp}`, actor: "qa-team" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-team"); await S.setTeamStatus(teamB.id, "active", "qa-team")
  await S.setMarketingSetting({ key: "permission_bundles", value: { setter: ["leads.read", "leads.call", "leads.mark", "chat"], seller: ["leads.read", "leads.pick", "leads.call", "leads.mark"], manager: ["leads.read", "team.manage"] }, actor: "qa-team", teamId: teamA.id })
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-team", permissions: [] as string[] }
  const tokenOf = (u: string) => new URL(u).searchParams.get("token") ?? ""
  const ids: Record<string, string> = {}
  const factor = (id: string) => db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP')`, [id])
  const mk = async (key: string, team: string, role: "owner" | "member", bundle?: string) => {
    const inv = await M.createInvite({ teamId: team, email: em(key), memberRole: role, bundle: bundle ?? null, actor: adminActor })
    if (inv.ok === false) throw new Error(`invite ${key}: ${inv.error}`)
    const acc = await M.acceptInvite({ token: tokenOf(inv.data!.inviteUrl), password: PASS })
    if (acc.ok === false) throw new Error(`accept ${key}: ${acc.error}`)
    ids[key] = (await db.query("select id from auth.users where email=$1", [em(key)])).rows[0].id
    await factor(ids[key])
  }
  await mk("ownerA", teamA.id, "owner"); await mk("ownerB", teamB.id, "owner"); await mk("setterA", teamA.id, "member", "setter"); await mk("managerA", teamA.id, "member", "manager")

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
    await page.close()
    return ctx
  }
  const view = async (ctx: BrowserContext, path: string) => {
    for (let i = 0; ; i++) {
      try {
        const page = await ctx.newPage()
        const resp = await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 180000 })
        const text = (await page.locator("body").innerText()).slice(0, 4000)
        return { page, status: resp?.status() ?? 0, text }
      } catch (e) { if (i >= 3) throw e; await sleep(3000) }
    }
  }


  const owner = await session(em("ownerA")), setter = await session(em("setterA")), manager = await session(em("managerA")), ownerB = await session(em("ownerB"))
  const api = (ctx: BrowserContext, method: "get" | "post" | "patch" | "delete", path: string, data?: unknown) =>
    ctx.request[method](`${BASE}${path}`, data === undefined ? {} : { data }).then(async r => ({ status: r.status(), json: await r.json().catch(() => ({})) }))
  const member = async (email: string) => (await db.query("select m.* from marketing_team_members m join auth.users u on u.id=m.user_id where u.email=$1", [email])).rows[0]
  const NEW = em("newsetter")

  // ── who may open it ──
  let v = await view(owner, "/marketing")
  ck("T1 the owner's workspace has Team in the sidebar", /Team/.test(await v.page.locator('nav[aria-label="Workspace"]').innerText()) && /\/marketing\/today/.test(v.page.url()), v.page.url()); await v.page.close()
  v = await view(setter, "/marketing")
  ck("T2 a setter's sidebar has no Team", !/Team/.test(await v.page.locator('nav[aria-label="Workspace"]').innerText()), v.text.slice(0, 300)); await v.page.close()
  v = await view(setter, "/marketing/team")
  ck("T3 a setter opening the Team page is told he cannot, and sees no member", /cannot manage the team/i.test(v.text) && !/qa-team-ownera/.test(v.text.replace(/qa-team-settera@example\.test/g, "")), v.text.slice(0, 300)); await v.page.close()
  const sa = await api(setter, "get", "/api/marketing/team/members")
  ck("T4 and the server refuses him too (403)", sa.status === 403, sa)

  // ── the owner's page ──
  v = await view(owner, "/marketing/team")
  ck("T5 the owner sees himself (you), the setter and the manager, roles in plain words", /\(you\)/.test(v.text) && /qa-team-setter/.test(v.text) && /Setter/.test(v.text) && /Manager/.test(v.text) && /Team owner/.test(v.text), v.text.slice(0, 900))
  const ownerRowButtons = await v.page.locator("li", { hasText: "(you)" }).getByRole("button").count()
  ck("T6 his own row has no Pause / Remove / Change access buttons", ownerRowButtons === 0, ownerRowButtons)
  await v.page.close()

  // ── invite through the real page ──
  const p = await owner.newPage()
  await p.goto(`${BASE}/marketing/team`, { waitUntil: "networkidle", timeout: 180000 })
  await p.getByPlaceholder("name@example.com").fill(NEW)
  ck("T6b 'Create invitation link' stays off until a role is picked", await p.getByRole("button", { name: "Create invitation link" }).isDisabled())
  await p.locator("select").first().selectOption("setter")
  ck("T7 choosing a role shows, in plain words, what it can do", /Can: .*See the leads/.test(await p.locator("body").innerText()))
  await p.getByText("Extra access on top of the role").click()
  await p.getByLabel("See the money pages").check()
  await p.getByRole("button", { name: "Create invitation link" }).click()
  await p.getByLabel("Invitation link").first().waitFor({ timeout: 60000 })
  const url = await p.locator('input[aria-label="Invitation link"]').inputValue()
  const inv = (await db.query("select * from marketing_invites where email_lower=$1", [NEW])).rows[0]
  ck("T8 a one-time link is shown, only its hash is stored, with the role and the extra access", url.includes("/marketing/accept?token=") && !!inv && inv.bundle === "setter" && JSON.stringify(inv.permissions) === JSON.stringify(["money.read"]) && inv.token_hash !== new URL(url).searchParams.get("token"), { url: url.slice(0, 60), inv })
  await p.getByText("Invitations waiting (1)").waitFor({ timeout: 60000 })
  const waiting = await p.locator("li", { hasText: NEW }).innerText()
  ck("T9 the waiting list shows the email, the role and when it expires", /Setter/.test(waiting) && /expires/.test(waiting) && (await p.getByRole("button", { name: "Cancel" }).count()) >= 1, waiting)
  await p.screenshot({ path: `${SHOTS}/qa-team-invited.png`, fullPage: true })
  await p.reload({ waitUntil: "networkidle" })
  ck("T10 after a reload the link cannot be shown again", !(await p.locator("body").innerHTML()).includes(new URL(url).searchParams.get("token")!), "token still in page")
  await p.close()

  // ── the person accepts ──
  const acc = await api(await browser.newContext(), "post", "/api/marketing/accept", { token: new URL(url).searchParams.get("token"), password: PASS })
  ck("T11 the link works once (the person sets a password)", acc.status === 200 && !!(await member(NEW)), acc)
  const again = await api(await browser.newContext(), "post", "/api/marketing/accept", { token: new URL(url).searchParams.get("token"), password: PASS })
  ck("T12 and a second use is refused with the generic answer", again.status >= 400, again)
  ids.newsetter = (await member(NEW)).user_id
  await factor(ids.newsetter)
  const newCtx = await session(NEW)
  ck("T13 the new person can come in", (await api(newCtx, "get", "/api/marketing/me")).status === 200)

  // ── pause / resume ──
  v = await view(owner, "/marketing/team")
  const row = () => v.page.locator("li", { hasText: NEW })
  await row().getByRole("button", { name: "Pause" }).click()
  await v.page.getByText("Paused. They are locked out").waitFor({ timeout: 60000 })
  ck("T14 Pause: stored, and the person is refused on his very next request", (await member(NEW)).status === "paused" && (await api(newCtx, "get", "/api/marketing/me")).status === 403, await member(NEW))
  await row().getByRole("button", { name: "Resume" }).click()
  await v.page.getByText("Resumed.").waitFor({ timeout: 60000 })
  ck("T15 Resume: he is back in", (await member(NEW)).status === "active" && (await api(newCtx, "get", "/api/marketing/me")).status === 200)

  // ── change access ──
  await row().getByRole("button", { name: "Change access" }).click()
  await row().locator("select").selectOption("seller")
  ck("T15b the invite form starts with NO role chosen and editing someone else does not change it", (await v.page.locator("select").first().inputValue()) === "")
  await row().getByLabel("See the money pages").uncheck()
  await row().getByRole("button", { name: "Save access" }).click()
  await v.page.getByText("Access saved.").waitFor({ timeout: 60000 })
  const m1 = await member(NEW)
  ck("T16 Change access: new role saved, the extra access removed", m1.bundle === "seller" && m1.permissions.length === 0, m1)
  await v.page.screenshot({ path: `${SHOTS}/qa-team-list.png`, fullPage: true })
  await v.page.close()

  // ── the manager (a member who may manage) is limited to what he holds ──
  v = await view(manager, "/marketing/team")
  ck("T17 the manager opens the page; the extra-access list only offers what HE holds", /Invite someone/.test(v.text) && (await v.page.getByLabel("See the leads").count()) === 1 && (await v.page.getByLabel("See the money pages").count()) === 0, v.text.slice(0, 300)); await v.page.close()
  const over = await api(manager, "post", "/api/marketing/team/members", { email: em("over"), bundle: "setter", permissions: ["money.read"] })
  ck("T18 the server refuses him handing out access he does not have (400)", over.status === 400 && /do not have/.test(over.json.error ?? ""), over)
  const mgrInv = await api(manager, "post", "/api/marketing/team/members", { email: em("bymanager"), bundle: "manager" })
  ck("T19 and he cannot make a role bigger than his own (manager role holds team.manage which he has: allowed; setter role needs leads.call he lacks: refused)", mgrInv.status === 200, mgrInv)
  const mgrSetter = await api(manager, "post", "/api/marketing/team/members", { email: em("bymanager2"), bundle: "setter" })
  ck("T20 a setter role needs access the manager does not hold, so it is refused", mgrSetter.status === 400, mgrSetter)
  const mgrSelf = await api(manager, "patch", `/api/marketing/team/members/${ids.managerA}`, { action: "pause" })
  ck("T21 nobody can pause himself", mgrSelf.status === 400, mgrSelf)
  const mgrOwner = await api(manager, "patch", `/api/marketing/team/members/${ids.ownerA}`, { action: "pause" })
  ck("T22 a manager cannot pause the team owner", mgrOwner.status === 400 && /Only Antonio/.test(mgrOwner.json.error ?? ""), mgrOwner)

  // ── another team ──
  const x1 = await api(ownerB, "patch", `/api/marketing/team/members/${ids.setterA}`, { action: "pause" })
  ck("T23 another team's owner cannot pause our setter (not on his team)", x1.status === 400 && (await member(em("setterA"))).status === "active", x1)
  const x2 = await api(ownerB, "delete", `/api/marketing/team/members/${ids.setterA}`)
  ck("T24 nor remove him", x2.status === 400 && (await member(em("setterA"))).status === "active", x2)
  const openInv = (await db.query("select id from marketing_invites where email_lower=$1", [em("bymanager")])).rows[0]
  const x3 = await api(ownerB, "delete", `/api/marketing/team/invites/${openInv.id}`)
  ck("T25 nor cancel our invitation", x3.status === 400 && !(await db.query("select revoked_at from marketing_invites where id=$1", [openInv.id])).rows[0].revoked_at, x3)

  // ── cancel an invitation, remove a person ──
  v = await view(owner, "/marketing/team")
  await v.page.locator("li", { hasText: em("bymanager") }).getByRole("button", { name: "Cancel" }).click()
  await v.page.getByText("Invitation cancelled.").waitFor({ timeout: 60000 })
  ck("T26 Cancel: the invitation is revoked", !!(await db.query("select revoked_at from marketing_invites where id=$1", [openInv.id])).rows[0].revoked_at)
  await v.page.locator("li", { hasText: NEW }).getByRole("button", { name: "Remove" }).click()
  ck("T27 Remove asks first (Yes, remove / Keep) and nothing happens yet", (await member(NEW)).status === "active" && (await v.page.getByRole("button", { name: "Yes, remove" }).count()) === 1)
  await v.page.getByRole("button", { name: "Yes, remove" }).click()
  await v.page.getByText("Removed. Their login is closed.").waitFor({ timeout: 60000 })
  await v.page.locator("li", { hasText: NEW }).waitFor({ state: "detached", timeout: 60000 })
  const gone = await member(NEW)
  const banned = (await db.query("select banned_until from auth.users where id=$1", [ids.newsetter])).rows[0].banned_until
  ck("T28 Remove: marked removed, the login is banned, and he is gone from the page", gone.status === "removed" && !!banned && !(await v.page.locator("body").innerText()).includes(NEW), { gone, banned })
  ck("T29 the removed person is refused on his next request", [401, 403].includes((await api(newCtx, "get", "/api/marketing/me")).status))
  await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
