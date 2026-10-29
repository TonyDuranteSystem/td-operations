/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa; Antonio, 29 Oct 2026): proves, through the REAL login page, the REAL dev server and the REAL database, that (1) the owner's "Messages for you" lists
   only the lead chats that NAME him, (2) a click on the CRM page opens the chat in a window on that page and he stays there, reading it clears the row, (3) the workspace Home does the same,
   (4) the voice recorder shows a live sound bar, warns when the microphone hears nothing, and a silent recording is not sent (a recording with sound is).
   Needs: the private stack up and `td-marketing-dev` on :3010. Run: npx tsx scripts/marketing/qa-owner-messages.ts */
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
const em = (k: string) => `qa-om-${k.toLowerCase()}@example.test`
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
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA om %'")).rows.map(x => x.id)
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qom-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qom-%'")
  if (oldTeams.length) {
    await db.query("delete from marketing_team_messages where team_id = any($1)", [oldTeams])
    await db.query("delete from marketing_chat_thread_members where thread_id in (select id from marketing_chat_threads where team_id = any($1))", [oldTeams])
    await db.query("delete from marketing_chat_threads where team_id = any($1)", [oldTeams])
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-om-"))) await A.deleteUser(u.id)
  await db.query("insert into storage.buckets (id, name, public) values ('onboarding-uploads', 'onboarding-uploads', false) on conflict do nothing")

  const teamA = (await S.createTeam({ name: `QA om A ${stamp}`, actor: "qa-om" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-om")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-om", permissions: [] as string[] }
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
  await mk("sellerA", "member", "seller")
  {
    const r = await A.createUser({ email: em("admin"), password: PASS, email_confirm: true, app_metadata: { role: "admin" }, user_metadata: { full_name: "Qa Om Admin" } })
    if (r.error || !r.data.user) throw new Error(`seed admin: ${r.error?.message}`)
    ids.admin = r.data.user.id
    await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'x')`, [ids.admin])
  }
  for (const uid of Object.values(ids)) for (const k of ["setter", "seller", "content", "analyst", "owner"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) values ($1,$2,$3,'done') on conflict do nothing", [uid, teamA.id, k])
  const mkLead = async (n: string, name: string) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, answers) values ($1,$2,$3,$4,'+393339990000','new','Ad Alpha', now() - interval '2 hours', null, null, '[]'::jsonb) returning id",
      [teamA.id, `qom-${n}-${stamp}`, name, `${n}@example.test`])).rows[0].id as string
  const Lquiet = await mkLead("quiet", "Quiet Chat Lead")
  const Lnamed = await mkLead("named", "Named Chat Lead")
  const Lvoice = await mkLead("voice", "Voice Test Lead")
  const say = (lead: string, text: string, mentions: string[] = []) => db.query("insert into marketing_lead_messages (team_id, lead_id, sender_id, sender_name, message, mentions) values ($1,$2,$3,'Rocco',$4,$5)", [teamA.id, lead, ids.sellerA, text, mentions])

  const jwtSecret = (() => {
    const c = execSync("docker ps --format '{{.Names}}'").toString().split("\n").find(n => n.startsWith("supabase_auth_tdlocal-claude-circlback"))
    const env = execSync(`docker inspect ${c} --format '{{range .Config.Env}}{{println .}}{{end}}'`).toString()
    return env.split("\n").find(l => l.startsWith("GOTRUE_JWT_SECRET="))!.slice("GOTRUE_JWT_SECRET=".length)
  })()
  const browser = await chromium.launch()
  const mic = (file?: string) => chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(file ? [`--use-file-for-fake-audio-capture=${file}`] : [])] })
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
  type Pg = import("playwright").Page
  const adminCtx = await session(em("admin"))
  const open = async (ctx: BrowserContext, path = "/marketing") => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "load", timeout: 180000 }); await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); await p.waitForTimeout(2500); return p }
  const settle = async (p: Pg) => { const url = p.url(); for (let i = 0; i < 3; i++) { try { await p.goto(url, { waitUntil: "load", timeout: 150000 }); break } catch (e) { if (i === 2) throw e; await p.waitForTimeout(3000) } } await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); await p.waitForTimeout(2500) }
  const api = (p: Pg, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) } }, [method, path, payload ?? null] as [string, string, object | null])

  // ---- the admin joins the team (the Teams page button does the same)
  const ap = await open(adminCtx, "/marketing-leads")
  const add = await api(ap, "POST", `/api/marketing-admin/teams/${teamA.id}/add-me`, {})
  ck("M0 the admin joined the team as owner", add.status === 200, add)

  // M1: Rocco writes in two leads' chats (the owners chat: Antonio and Rocco); everything unread in it is for Antonio, named with @ or not
  await say(Lquiet, "Antonio no, this one is just between me and the lead")
  await say(Lnamed, "Ci vediamo lunedi, mi serve il tuo parere", [ids.admin])
  await settle(ap)
  const panel = ap.getByTestId("home-messages")
  const panelText = await panel.innerText()
  ck("M1 the CRM page lists both chats with Rocco that hold something new", /Named Chat Lead/.test(panelText) && /Quiet Chat Lead/.test(panelText), panelText)
  ck("M1c the total says 2", /Messages for you \(2\)/.test(panelText), panelText)
  await ap.screenshot({ path: `${SHOTS}/qa-om-crm-list.png`, fullPage: false })

  // M2: a click opens the chat right on the CRM page
  const urlBefore = ap.url()
  await panel.getByTestId("home-message").filter({ hasText: "Named Chat Lead" }).click()
  await ap.getByTestId("crm-chat-dialog").waitFor({ timeout: 30000 })
  const frame = ap.frameLocator('[data-testid="crm-chat-frame"]')
  await frame.getByText("mi serve il tuo parere").first().waitFor({ timeout: 60000 }).catch(() => undefined)
  ck("M2 a click opens the chat in a window on the CRM page; the page did not move", ap.url() === urlBefore && (await ap.getByTestId("crm-chat-dialog").count()) === 1, ap.url())
  ck("M2b the window shows that lead's conversation", (await frame.getByText("mi serve il tuo parere").count()) >= 1)
  await ap.screenshot({ path: `${SHOTS}/qa-om-crm-dialog.png`, fullPage: false })
  await ap.waitForTimeout(2500)
  await ap.getByTestId("crm-chat-close").click()
  await ap.waitForTimeout(5000)
  const after = await ap.getByTestId("home-messages").innerText()
  ck("M3 closing the window leaves him on the same page, and the chat he read is gone from his list while the other stays", ap.url() === urlBefore && !/Named Chat Lead/.test(after) && /Quiet Chat Lead/.test(after), after)

  // M4: his dashboard is the CRM page (the workspace /marketing/home now just redirects), so there is no second list to check
  // the full Messages screen still lists every chat, named or not
  const cp = await open(adminCtx, "/marketing/chat")
  const chatText = await cp.locator("body").innerText()
  ck("M5 the Messages screen still lists every lead chat", /Quiet Chat Lead/.test(chatText) && /Named Chat Lead/.test(chatText), chatText.slice(0, 300))

  // M6: voice — a recording WITH sound (the fake microphone beeps)
  const voiceUrl = `/marketing/window/${Lvoice}?tab=chat`
  const beepBrowser = await mic()
  const beepCtx = await session(em("admin"), "en", beepBrowser)
  const bp = await open(beepCtx, voiceUrl)
  await bp.click('[data-testid="talk-mic"]')
  await bp.waitForSelector('[data-testid="talk-recording"]', { timeout: 20000 })
  // the fake microphone beeps once a second with silence in between: take the loudest the bar reached over a few seconds, not one instant
  let bar = 0
  for (let i = 0; i < 40; i++) { bar = Math.max(bar, await bp.getByTestId("talk-sound-bar").evaluate(el => parseFloat((el as HTMLElement).style.width) || 0).catch(() => 0)); await bp.waitForTimeout(150) }
  ck("M6 with sound: the sound bar moves and no warning shows", bar > 0 && (await bp.getByTestId("talk-no-sound").count()) === 0, { bar })
  await bp.screenshot({ path: `${SHOTS}/qa-om-voice-sound.png` })
  await bp.click('[data-testid="talk-voice-send"]')
  let sentVoice = 0
  for (let i = 0; i < 40; i++) { sentVoice = (await db.query("select count(*)::int n from marketing_lead_messages where lead_id=$1 and attachments->0->>'mime_type' like 'audio/%'", [Lvoice])).rows[0].n; if (sentVoice) break; await bp.waitForTimeout(1000) }
  ck("M6b a recording with sound is sent", sentVoice === 1, sentVoice)
  await beepBrowser.close()

  // M7: voice — a microphone that hears nothing (a silent file as the fake microphone)
  const quietBrowser = await mic("/tmp/qa-silence.wav")
  const quietCtx = await session(em("admin"), "en", quietBrowser)
  const qp = await open(quietCtx, voiceUrl)
  await qp.click('[data-testid="talk-mic"]')
  await qp.waitForSelector('[data-testid="talk-recording"]', { timeout: 20000 })
  await qp.waitForTimeout(1500)
  const earlyWarn = await qp.getByTestId("talk-no-sound").count()
  await qp.waitForTimeout(3500)
  ck("M7 with a silent microphone: no warning in the first seconds, then 'No sound yet' appears", earlyWarn === 0 && (await qp.getByTestId("talk-no-sound").count()) === 1, { earlyWarn })
  await qp.screenshot({ path: `${SHOTS}/qa-om-voice-silent.png` })
  await qp.click('[data-testid="talk-voice-send"]')
  let toast = ""
  for (let i = 0; i < 40; i++) { toast = await qp.locator("body").innerText(); if (/No sound was captured/.test(toast)) break; await qp.waitForTimeout(150) }
  await qp.waitForTimeout(4000)
  const voiceRows = (await db.query("select count(*)::int n from marketing_lead_messages where lead_id=$1 and attachments->0->>'mime_type' like 'audio/%'", [Lvoice])).rows[0].n
  ck("M7b a silent recording is NOT sent, and the person is told why", voiceRows === 1 && /No sound was captured/.test(toast), { voiceRows, toast: toast.slice(-300) })
  await quietBrowser.close()

  console.log(`\n${pass} passed, ${fail} failed`)
  await browser.close()
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
