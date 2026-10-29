/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa; Antonio, 29 Oct 2026): "View as Setter" must show what a SETTER sees, not what Antonio sees. Through the REAL login, the REAL dev server and the REAL database:
   Antonio (admin) previews the Setter: his chat list holds only what setters wrote (never Rocco's messages that name HIM), and none of his own direct chats; previewing the Owner still shows everything.
   Needs: the private stack up and `td-marketing-dev` on :3010. Run: npx tsx scripts/marketing/qa-viewas-chat.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const stamp = Date.now()
const em = (k: string) => `qa-vc-${k.toLowerCase()}@example.test`
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
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA vc %'")).rows.map(x => x.id)
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qvc-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qvc-%'")
  if (oldTeams.length) {
    await db.query("delete from marketing_team_messages where team_id = any($1)", [oldTeams])
    await db.query("delete from marketing_chat_thread_members where thread_id in (select id from marketing_chat_threads where team_id = any($1))", [oldTeams])
    await db.query("delete from marketing_chat_threads where team_id = any($1)", [oldTeams])
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-vc-"))) await A.deleteUser(u.id)
  await db.query("insert into storage.buckets (id, name, public) values ('onboarding-uploads', 'onboarding-uploads', false) on conflict do nothing")

  const teamA = (await S.createTeam({ name: `QA vc A ${stamp}`, actor: "qa-vc" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-vc")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-vc", permissions: [] as string[] }
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
      [teamA.id, `qvc-${n}-${stamp}`, name, `${n}@example.test`])).rows[0].id as string
  const Lquiet = await mkLead("quiet", "Quiet Chat Lead")
  const Lnamed = await mkLead("named", "Named Chat Lead")
  const say = (lead: string, text: string, mentions: string[] = [], by = "ownerA") => db.query("insert into marketing_lead_messages (team_id, lead_id, sender_id, sender_name, message, mentions, lane) values ($1,$2,$3,$4,$5,$6,$7)", [teamA.id, lead, ids[by], by === "setterA" ? "Setter" : "Rocco", text, mentions, by === "setterA" ? "setter" : "owners"])

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

  const adminCtx = await session(em("admin"))
  const open = async (ctx: BrowserContext, path = "/marketing") => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "load", timeout: 180000 }); await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); return p }
  const get = (p: import("playwright").Page, path: string) => p.evaluate(async u => { const r = await fetch(u as string); return { status: r.status, body: await r.json().catch(() => null) } }, path)

  // data: Rocco writes to Antonio in two leads (naming him), the setter writes in her own lead, Antonio and Rocco have a direct chat
  await say(Lquiet, "Antonio, questo lo vedi tu", [ids.admin])
  await say(Lnamed, "Ci vediamo lunedi", [ids.admin])
  const setterLead = await mkLead("setter", "Setter Own Lead")
  await say(setterLead, "Rocco, ho parlato col lead", [], "setterA")
  const th = (await db.query("insert into marketing_chat_threads (team_id, kind, dm_key, created_by) values ($1,'dm',$2,$3) returning id", [teamA.id, `${ids.admin}:${ids.ownerA}`, ids.admin])).rows[0].id
  await db.query("insert into marketing_chat_thread_members (thread_id, user_id, added_by) values ($1,$2,$2),($1,$3,$2)", [th, ids.admin, ids.ownerA])
  await db.query("insert into marketing_team_messages (team_id, thread_id, sender_id, sender_name, message) values ($1,$2,$3,'Antonio','Ciao rocco')", [teamA.id, th, ids.admin])

  const ap = await open(adminCtx, "/marketing-leads")
  const asOwner = await ap.request.post(`${BASE}/api/marketing-admin/view-as`, { data: { teamId: teamA.id, as: "owner" } })
  const ownerList = await get(ap, "/api/marketing/chat/conversations")
  const ownerNames = ((ownerList.body?.conversations ?? []) as Array<{ name: string }>).map(c => c.name)
  ck("V1 previewing the OWNER shows every lead chat", asOwner.ok() && ownerNames.length === 3, ownerNames)
  const ownerThreads = await get(ap, "/api/marketing/team-chat/threads")
  ck("V2 previewing the OWNER still shows his direct chat", ((ownerThreads.body?.threads ?? []) as unknown[]).length === 1, ownerThreads)

  const asSetter = await ap.request.post(`${BASE}/api/marketing-admin/view-as`, { data: { teamId: teamA.id, as: "setter" } })
  const setterList = await get(ap, "/api/marketing/chat/conversations")
  const setterNames = ((setterList.body?.conversations ?? []) as Array<{ name: string }>).map(c => c.name)
  ck("V3 previewing the SETTER lists only the chat a setter wrote in", asSetter.ok() && setterNames.length === 1 && setterNames[0] === "Setter Own Lead", setterNames)
  ck("V4 and none of Rocco's messages that name Antonio", !setterNames.includes("Quiet Chat Lead") && !setterNames.includes("Named Chat Lead"), setterNames)
  const setterThreads = await get(ap, "/api/marketing/team-chat/threads")
  ck("V5 and none of Antonio's own direct chats", ((setterThreads.body?.threads ?? []) as unknown[]).length === 0, setterThreads)
  const quietChat = await get(ap, `/api/marketing/chat/${Lquiet}`)
  ck("V6 opening a chat Rocco wrote to Antonio shows the setter nothing", ((quietChat.body?.messages ?? []) as unknown[]).length === 0, quietChat)
  const dmOpen = await get(ap, `/api/marketing/team-chat/${th}`)
  ck("V7 opening Antonio's direct chat by its address is refused in the preview", dmOpen.status === 404 || dmOpen.status === 403, dmOpen.status)

  console.log(`\n${pass} passed, ${fail} failed`)
  await browser.close()
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
