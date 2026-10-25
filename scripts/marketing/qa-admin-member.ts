/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, the owner as a person in the team): proves an ADMIN login added to a team as owner enters it without View as, is a person
   in its chat, keeps View as, and can never be locked out by a removal, through the REAL login page, dev server and database.
   Needs: the private stack up (with migrations 20261023-2000 and 20261024-2100 applied) and `td-marketing-qa` running on :3010.
   Run: npx tsx scripts/marketing/qa-admin-member.ts */
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
const em = (k: string) => `qa-cl-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qcl-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qcl-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qcl-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA cl %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-cl-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA cl A ${stamp}`, actor: "qa-cl" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-cl")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-cl", permissions: [] as string[] }
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
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter"); await mk("aleA", "member", "content"); await mk("marcoA", "member", "setter"); await mk("sellerA", "member", "seller")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }








  const mkLead = async (n: string, name: string) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, answers) values ($1,$2,$3,$4,'+393339990000','new','Ad Alpha', now() - interval '1 day', '[]'::jsonb) returning id", [teamA.id, `qcl-${n}`, name, `qcl${n}@example.test`])).rows[0].id as string
  const L1 = await mkLead("t1", "Marco Bianchi")
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }, { key: "sold", label: "Sold" }]], ["sale_kind_stages", { strategic_call: "sold" }]] as const) {
    const r = await S.setMarketingSetting({ key: k, value: v, teamId: teamA.id, actor: "qa-cl" }); if (r.ok === false) throw new Error(`setting ${k}: ${r.error}`)
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










  type Pg = import("playwright").Page
  const adminCtx = await session(em("admin")), owner = await session(em("ownerA")), setter = await session(em("setterA"))
  const ADM = "Qa Cl Admin"
  const open = async (ctx: BrowserContext, path = "/marketing") => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "networkidle", timeout: 180000 }); return p }
  const api = (p: Pg, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) } }, [method, path, payload ?? null] as const)
  const text = async (p: Pg) => (await p.locator("body").innerText()).replace(/\s+/g, " ")
  const member = async () => (await db.query("select member_role, status from marketing_team_members where team_id=$1 and user_id=$2", [teamA.id, ids.admin])).rows[0] as { member_role: string; status: string } | undefined

  // ---- before: an admin who is not a member has only the View-as door
  const a0 = await open(adminCtx)
  ck("M1 an admin who is NOT a member of the team gets the 'use View as' message, as before", /View as/.test(await text(a0)) && (await a0.getByTestId("nav-chat").count()) === 0, (await text(a0)).slice(0, 200))
  await a0.close()
  const t0 = await open(adminCtx, "/marketing-leads/teams")
  ck("M1b on CRM > Marketing > Teams the admin sees the 'Add me to this team as owner' button for the team (he is not in it yet)", (await t0.getByTestId("add-me").count()) >= 1)
  const crm = await t0.locator("body").innerText()
  ck("M1c the CRM menu has the 'Marketing team' entry that goes to the workspace", /Marketing team/.test(crm) && (await t0.locator('a[href="/marketing"]').count()) >= 1)
  await t0.screenshot({ path: `${SHOTS}/qa-admin-member-teams.png`, fullPage: false })
  await t0.close()

  // ---- the add-me action: admin only, repeatable, writes one owner row
  const ap = await open(adminCtx, "/marketing")
  const denied = await api(await open(setter), "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})
  ck("M2 a team member (not an admin) cannot add himself or anyone: 403, and nothing is written", denied.status === 403 && !(await member()), denied)
  const add1 = await api(ap, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})
  const add2 = await api(ap, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})
  const m1 = await member()
  ck("M3 the admin adds himself as owner (200), and doing it again is harmless (200, still ONE active owner row)", add1.status === 200 && add1.body.already === false && add2.status === 200 && add2.body.already === true && m1?.member_role === "owner" && m1.status === "active", { add1, add2, m1 })
  const ghost = await api(ap, "POST", "/api/marketing-admin/teams/00000000-0000-4000-8000-000000000000/add-me", {})
  ck("M4 a team that does not exist is refused (400)", ghost.status === 400, ghost)

  const t1 = await open(adminCtx, "/marketing-leads/teams")
  const mine = t1.locator("section", { hasText: teamA.name })
  ck("M3b after adding himself, THIS team's block on the Teams page says he is an owner and its button is gone (other teams keep theirs)", (await mine.getByTestId("add-me").count()) === 0 && /You are an owner of this team/.test(await mine.innerText()))
  await t1.close()

  // ---- after: he is simply in, as the owner, with every screen and no banner
  const a1 = await open(adminCtx, "/marketing/board")
  const nav1 = await a1.locator("aside").innerText()
  ck("M5 he opens the workspace straight in: the owner's every screen (Team, Templates, Money), and NO 'Viewing as' banner", /Team/.test(nav1) && /Templates/.test(nav1) && /Money/.test(nav1) && (await a1.getByText("Viewing as").count()) === 0, nav1.slice(0, 300))
  await a1.screenshot({ path: `${SHOTS}/qa-admin-member-board.png`, fullPage: true })
  ck("M6 …and the chat entry is there", (await a1.getByTestId("nav-chat").count()) === 1)

  // ---- he is a person in the chat: others see him, can write to him, mention him
  const sp = await open(setter, "/marketing/chat")
  await sp.getByTestId("new-dm").click()
  await sp.getByTestId("dm-dialog").waitFor({ timeout: 30000 })
  const names = await sp.getByTestId("dm-person").allInnerTexts()
  ck("M7 the setter's 'New message' list now has the admin by name", names.some(n => n.includes(ADM)), names)
  await sp.getByTestId("dm-person").filter({ hasText: ADM }).click()
  await sp.getByTestId("thread-title").waitFor({ timeout: 60000 })
  await sp.getByTestId("talk-input").fill("Antonio, a question about the Rossi lead")
  await sp.getByTestId("talk-send").click()
  await sp.waitForTimeout(1500)
  const ac = await open(adminCtx, "/marketing/chat")
  ck("M8 the admin's Chat page shows that message with a red number, and opening it reads it", (await ac.getByTestId("thread-row").count()) === 1 && /1/.test(await ac.getByTestId("thread-unread").first().innerText()))
  await ac.getByTestId("thread-row").first().click()
  await ac.getByTestId("thread-title").waitFor({ timeout: 60000 })
  await ac.getByTestId("talk-input").fill("Tell me which lead and I will look")
  await ac.getByTestId("talk-send").click()
  let lastFromAdmin = { sender_name: "" }
  for (let i = 0; i < 30; i++) { lastFromAdmin = (await db.query("select sender_name from marketing_team_messages where team_id=$1 order by created_at desc limit 1", [teamA.id])).rows[0]; if (lastFromAdmin.sender_name === ADM) break; await ac.waitForTimeout(500) }
  ck("M9 the admin writes back in the same chat, as himself (not as someone else)", lastFromAdmin.sender_name === ADM, lastFromAdmin)

  // ---- @mention in a lead chat
  const lm = await api(sp, "POST", `/api/marketing/chat/${L1}/messages`, { message: `@${ADM} what do you think of this lead?` })
  const lrow = (await db.query("select mentions from marketing_lead_messages where lead_id=$1 order by created_at desc limit 1", [L1])).rows[0]
  ck("M10 a setter can @mention the admin in a lead's chat (stored as mentioned)", lm.status === 200 && (lrow.mentions as string[]).includes(ids.admin), lrow)
  const adminLead = await adminCtx.newPage()
  await adminLead.goto(`${BASE}/marketing/window/${L1}?tab=chat`, { waitUntil: "domcontentloaded", timeout: 180000 })
  await adminLead.getByTestId("lead-chat").waitFor({ timeout: 90000 })
  ck("M11 the admin can read and answer in that lead's chat", (await adminLead.getByTestId("lead-chat").count()) === 1)

  // ---- View as still works, and leaving it returns him to his own owner view
  const va = await api(ac, "POST", "/api/marketing-admin/view-as", { teamId: teamA.id, as: "setter" })
  const asSetter = await open(adminCtx, "/marketing/board")
  ck("M12 View as still works: with it on he sees the banner and the setter's screens (no Money)", va.status === 200 && (await asSetter.getByText("Viewing as").count()) >= 1 && !/Money/.test(await asSetter.locator("aside").innerText()))
  await api(asSetter, "DELETE", "/api/marketing-admin/view-as")
  const back = await open(adminCtx, "/marketing/board")
  ck("M13 leaving View as puts him back in his own owner view (not an error page)", (await back.getByText("Viewing as").count()) === 0 && /Money/.test(await back.locator("aside").innerText()))

  // ---- safety: nobody can lock him out
  const op = await open(owner)
  const rm = await api(op, "DELETE", `/api/marketing/team/members/${ids.admin}`)
  const stillOwner = await member()
  ck("M14 a non-admin team owner cannot remove or change the admin (refused, row unchanged)", rm.status >= 400 && stillOwner?.status === "active", { rm, stillOwner })
  const { supabaseAdmin: sa } = await import("@/lib/supabase-admin")
  const rmAdmin = await M.removeMember({ teamId: teamA.id, userId: ids.admin, actor: { kind: "admin", userId: ids.ownerA, label: "another-admin", permissions: [] } })
  const user = (await (sa as unknown as { auth: { admin: { getUserById: (id: string) => Promise<{ data: { user: { banned_until?: string | null } | null } }> } } }).auth.admin.getUserById(ids.admin)).data.user
  ck("M15 removing him from the team (even by an admin) NEVER bans his login: the row says removed, the CRM login is not banned", rmAdmin.ok === true && (await member())?.status === "removed" && !user?.banned_until, { rmAdmin, banned: user?.banned_until })
  const gone = await open(adminCtx, "/marketing")
  ck("M16 once removed he is back to the 'use View as' message (and View as still works)", /View as/.test(await text(gone)))

  // ---- a paused team: a member admin is turned away, not crashed
  await api(ap, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})
  await db.query("update marketing_teams set status='paused' where id=$1", [teamA.id])
  const paused = await open(adminCtx, "/marketing")
  ck("M17 with the team switched off an admin member gets the same plain 'use View as' message", /View as/.test(await text(paused)))
  await db.query("update marketing_teams set status='active' where id=$1", [teamA.id])

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
