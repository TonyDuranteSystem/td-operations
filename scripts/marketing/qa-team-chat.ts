/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, round 2 step 3: the team chat): proves direct messages, groups, @mentions (in the team chat and in the
   chat about a lead), who can read what, and that a stranger is refused, through the REAL login page, dev server and database.
   Needs: the private stack up (with migrations 20261023-2000 and 20261024-2100 applied) and `td-marketing-qa` running on :3010.
   Run: npx tsx scripts/marketing/qa-team-chat.ts */
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
  const owner = await session(em("ownerA")), setter = await session(em("setterA")), ale = await session(em("aleA")), marco = await session(em("marcoA"))
  const OWN = "Qa Cl Ownera", SET = "Qa Cl Settera"
  const open = async (ctx: BrowserContext, path = "/marketing/chat") => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "networkidle", timeout: 180000 }); return p }
  const api = (p: Pg, method: string, path: string, payload?: object) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) } }, [method, path, payload ?? null] as const)
  const write = async (p: Pg, text: string) => { const box = p.getByTestId("talk-input"); await box.click(); await box.fill(text); await p.getByTestId("talk-send").click() }
  const threadOf = async (name: string) => (await db.query("select id from marketing_chat_threads where team_id=$1 and title=$2", [teamA.id, name])).rows[0]?.id as string | undefined

  // ---- a direct message, from the setter to the owner
  const sp = await open(setter)
  ck("C1 the setter's Chat page has Direct messages and Groups, and no group yet", (await sp.getByTestId("new-dm").count()) === 1 && (await sp.getByTestId("new-group").count()) === 1 && (await sp.getByTestId("thread-row").count()) === 0)
  await sp.getByTestId("new-dm").click()
  await sp.getByTestId("dm-dialog").waitFor({ timeout: 30000 })
  const people = await sp.getByTestId("dm-person").allInnerTexts()
  ck("C2 the people list has everyone who can chat, never the setter herself", people.length >= 3 && !people.some(p => p.includes(SET)) && people.some(p => p.includes(OWN)), people)
  await sp.getByTestId("dm-person").filter({ hasText: OWN }).click()
  await sp.getByTestId("thread-title").waitFor({ timeout: 60000 }).catch(async e => { await sp.screenshot({ path: `${SHOTS}/qa-team-fail.png`, fullPage: true }); console.log("PAGE:", (await sp.locator("body").innerText()).slice(0, 600)); throw e })
  ck("C3 the chat opens under the OTHER person's name", (await sp.getByTestId("thread-title").innerText()).includes(OWN))
  // the @ picker, then a message that names the owner
  await sp.getByTestId("talk-input").click()
  await sp.getByTestId("talk-input").fill("hello @")
  await sp.getByTestId("mention-picker").waitFor({ timeout: 30000 })
  ck("C4 typing @ opens the picker with the people of THIS chat (here: only the owner)", (await sp.getByTestId("mention-option").allInnerTexts()).join("|") === `@${OWN}`)
  await sp.keyboard.press("Enter")
  ck("C5 Enter chooses the person and writes @Name in the box", (await sp.getByTestId("talk-input").inputValue()) === `hello @${OWN} `)
  await sp.getByTestId("talk-input").fill(`hello @${OWN} can you call Elena?`)
  await sp.getByTestId("talk-send").click()
  await sp.getByTestId("mention").first().waitFor({ timeout: 60000 })
  const m1 = (await db.query("select mentions, message from marketing_team_messages where team_id=$1 order by created_at desc limit 1", [teamA.id])).rows[0]
  ck("C6 the message shows the name highlighted, and the owner's id is stored as mentioned", (await sp.getByTestId("mention").count()) >= 1 && (m1.mentions as string[]).includes(ids.ownerA), m1)
  await write(sp, "and a plain message with no mention")
  await sp.waitForTimeout(1500)
  const m2 = (await db.query("select mentions from marketing_team_messages where team_id=$1 order by created_at desc limit 1", [teamA.id])).rows[0]
  ck("C7 a plain message stores nobody as mentioned", (m2.mentions as string[]).length === 0, m2)
  await sp.screenshot({ path: `${SHOTS}/qa-team-dm.png`, fullPage: true })

  // ---- the owner sees the red number and the @ marker, and reading clears them
  const op = await open(owner)
  ck("C8 the owner's list shows the direct message with its red number and the yellow @", (await op.getByTestId("thread-row").count()) === 1 && /^2$/.test((await op.getByTestId("thread-unread").first().innerText()).trim()) && (await op.getByTestId("thread-mention").count()) === 1)
  ck("C9 the menu's Chat entry carries the number too", /Chat\s*2/.test(await op.locator("aside").innerText()))
  await op.getByTestId("thread-row").first().click()
  await op.getByTestId("mention").first().waitFor({ timeout: 60000 })
  await op.waitForTimeout(2500)
  const rd = (await db.query("select count(*) from marketing_team_chat_reads where team_id=$1 and user_id=$2", [teamA.id, ids.ownerA])).rows[0]
  ck("C10 opening it marks it read (the owner now has a read marker) and the list's number is gone", Number(rd.count) === 1 && (await op.getByTestId("thread-unread").count()) === 0)
  await write(op, "yes, I will call her")

  // ---- a stranger cannot read or write it (Ale is in the team but not in this chat)
  const dmId = (await db.query("select id from marketing_chat_threads where team_id=$1 and kind='dm'", [teamA.id])).rows[0].id as string
  const ap = await open(ale)
  const peek = await api(ap, "GET", `/api/marketing/team-chat/${dmId}`)
  const poke = await api(ap, "POST", `/api/marketing/team-chat/${dmId}/messages`, { message: "intruder" })
  const upl = await api(ap, "POST", `/api/marketing/team-chat/${dmId}/upload-url`, { file_name: "x.pdf" })
  ck("C11 a team member who is NOT in a conversation cannot read it, write in it or ask for an upload link (404 each), and nothing is written", peek.status === 404 && poke.status === 404 && upl.status === 404 && Number((await db.query("select count(*) from marketing_team_messages where message='intruder'")).rows[0].count) === 0, { peek: peek.status, poke: poke.status, upl: upl.status })
  ck("C12 Ale's Chat page has direct messages and groups but no 'Chats about leads' (he does not work the leads)", (await ap.getByTestId("new-dm").count()) === 1 && (await ap.getByTestId("lead-conversations").count()) === 0 && (await ap.getByTestId("thread-row").count()) === 0)

  // ---- a group
  await op.getByTestId("new-group").click()
  await op.getByTestId("group-dialog").waitFor({ timeout: 30000 })
  ck("C13 Create group stays off until there is a name and a member", (await op.getByTestId("group-create").isDisabled()) === true)
  await op.getByTestId("group-name").fill("Hot leads")
  await op.getByTestId("group-member").nth(0).check()
  ck("C14 …and comes on with both", (await op.getByTestId("group-create").isDisabled()) === false)
  const memberLabels = await op.getByTestId("group-member").evaluateAll(els => els.map(e => (e.closest("label")?.textContent ?? "").trim()))
  const want = ["Qa Cl Settera", "Qa Cl Alea"]
  for (let i = 0; i < memberLabels.length; i++) { const on = want.includes(memberLabels[i]); const box = op.getByTestId("group-member").nth(i); if (on) await box.check(); else await box.uncheck() }
  await op.getByTestId("group-create").click()
  await op.getByTestId("group-info").waitFor({ timeout: 60000 })
  const gid = await threadOf("Hot leads")
  const gm = gid ? (await db.query("select user_id from marketing_chat_thread_members where thread_id=$1", [gid])).rows.map(r => r.user_id as string) : []
  ck("C15 the group exists with exactly the owner, the setter and Ale as members", !!gid && gm.length === 3 && [ids.ownerA, ids.setterA, ids.aleA].every(x => gm.includes(x)), gm)
  await write(op, `@${SET} please check the new ones, and @Qa Cl Alea the ad numbers`)
  await op.waitForTimeout(1500)
  const gmsg = (await db.query("select mentions from marketing_team_messages where thread_id=$1", [gid])).rows[0]
  ck("C16 a message in the group names two people with multi-word names, both stored", (gmsg.mentions as string[]).length === 2 && (gmsg.mentions as string[]).includes(ids.setterA) && (gmsg.mentions as string[]).includes(ids.aleA), gmsg)
  await ap.reload({ waitUntil: "networkidle" })
  ck("C17 Ale sees the group with the red number and the yellow @", (await ap.getByTestId("thread-row").filter({ hasText: "Hot leads" }).count()) === 1 && (await ap.getByTestId("thread-mention").count()) === 1)

  // ---- group info: rename, add, leave
  await op.getByTestId("group-info").click()
  await op.getByTestId("info-name").fill("Hot leads Oct")
  await op.getByTestId("info-rename").click()
  await op.getByTestId("info-dialog").waitFor({ state: "detached", timeout: 30000 })
  await op.waitForTimeout(1500)
  ck("C18 renaming works (the title changes in the list and in the database)", !!(await threadOf("Hot leads Oct")) && (await op.getByTestId("thread-title").innerText()).includes("Hot leads Oct"))
  await op.getByTestId("group-info").click()
  const nOut = await op.getByTestId("info-add-member").count()
  await op.getByTestId("info-add-member").first().check()
  await op.getByTestId("info-add").click()
  await op.getByTestId("info-dialog").waitFor({ state: "detached", timeout: 30000 })
  ck("C19 adding a person puts them in the group", nOut >= 1 && (await db.query("select count(*) from marketing_chat_thread_members where thread_id=$1", [gid])).rows[0].count === "4")
  const marcoPage = await open(marco)
  ck("C20 the person added sees the group in their list", (await marcoPage.getByTestId("thread-row").filter({ hasText: "Hot leads Oct" }).count()) === 1)
  await op.getByTestId("group-info").click()
  await op.getByTestId("info-leave").click()
  await op.getByTestId("info-leave-sure").click()
  await op.getByTestId("info-dialog").waitFor({ state: "detached", timeout: 30000 })
  await op.waitForTimeout(1200)
  const afterLeave = await api(op, "GET", `/api/marketing/team-chat/${gid}`)
  ck("C21 leaving takes me out: the group is gone from my list, I cannot open it any more, and its messages are still in the database", (await op.getByTestId("thread-row").filter({ hasText: "Hot leads Oct" }).count()) === 0 && afterLeave.status === 404 && Number((await db.query("select count(*) from marketing_team_messages where thread_id=$1", [gid])).rows[0].count) === 1)

  // ---- edit, delete, react are the author's / the same rules as the lead chat
  const myMsg = (await db.query("select id from marketing_team_messages where thread_id=$1 and sender_id=$2", [dmId, ids.setterA])).rows[0].id as string
  const edOther = await api(op, "PATCH", `/api/marketing/team-chat/messages/${myMsg}`, { message: "hijacked" })
  const edStranger = await api(ap, "PATCH", `/api/marketing/team-chat/messages/${myMsg}`, { message: "hijacked" })
  const reactStranger = await api(ap, "POST", `/api/marketing/team-chat/messages/${myMsg}/react`, { emoji: "👍" })
  const edOwn = await api(sp, "PATCH", `/api/marketing/team-chat/messages/${myMsg}`, { message: "edited by me" })
  const reactOk = await api(op, "POST", `/api/marketing/team-chat/messages/${myMsg}/react`, { emoji: "👍" })
  ck("C22 only the author can edit (403 for the owner, 404 for a person who is not in the chat), anyone IN the chat can react, a stranger cannot", edOther.status === 403 && edStranger.status === 404 && reactStranger.status === 404 && edOwn.status === 200 && reactOk.status === 200 && reactOk.body.reactions?.length === 1, { edOther: edOther.status, edStranger: edStranger.status, edOwn: edOwn.status, reactOk })
  const delByOwner = await api(op, "DELETE", `/api/marketing/team-chat/messages/${myMsg}`)
  ck("C23 the team owner may delete someone's message (it stays as a note, the row is kept)", delByOwner.status === 200 && (await db.query("select deleted_at from marketing_team_messages where id=$1", [myMsg])).rows[0].deleted_at !== null)

  // ---- a person can start a chat only with someone who can chat in THIS team, and not with herself
  const self = await api(sp, "POST", "/api/marketing/team-chat/threads", { kind: "dm", user_id: ids.setterA })
  const ghost = await api(sp, "POST", "/api/marketing/team-chat/threads", { kind: "dm", user_id: "00000000-0000-4000-8000-000000000000" })
  const again = await api(sp, "POST", "/api/marketing/team-chat/threads", { kind: "dm", user_id: ids.ownerA })
  ck("C24 a chat with yourself (400) or with a stranger (400) is refused; asking again for the same pair gives the SAME chat", self.status === 400 && ghost.status === 400 && again.status === 200 && again.body.thread_id === dmId, { self: self.status, ghost: ghost.status, again: again.body })

  // ---- the chat about a lead: an @mention there stores who was named; an ordinary message still works
  const lm1 = await api(sp, "POST", `/api/marketing/chat/${L1}/messages`, { message: `@${OWN} the lead replied` })
  const lm2 = await api(sp, "POST", `/api/marketing/chat/${L1}/messages`, { message: "an ordinary message" })
  const lrows = (await db.query("select message, mentions from marketing_lead_messages where lead_id=$1 order by created_at", [L1])).rows
  ck("C25 in the chat about a lead the owner is stored as mentioned, and an ordinary message still sends with nobody mentioned", lm1.status === 200 && lm2.status === 200 && (lrows[0].mentions as string[]).includes(ids.ownerA) && (lrows[1].mentions as string[]).length === 0, lrows)
  const sp2 = await open(setter)
  ck("C26 the setter's Chat page lists the lead chat under 'Chats about leads', and a click opens the lead window", (await sp2.getByTestId("lead-conversations").count()) === 1)
  await sp2.getByTestId("conversation").first().click()
  await sp2.getByTestId("lead-window").waitFor({ timeout: 60000 })
  ck("C27 …and the lead window opens on the chat", (await sp2.getByTestId("lead-window").count()) === 1)

  // ---- a chat that once lost its members is healed the next time it is opened (never broken for good)
  await db.query("delete from marketing_chat_thread_members where thread_id=$1", [dmId])
  const brokenGet = await api(sp, "GET", `/api/marketing/team-chat/${dmId}`)
  const healed = await api(sp, "POST", "/api/marketing/team-chat/threads", { kind: "dm", user_id: ids.ownerA })
  const healedGet = await api(sp, "GET", `/api/marketing/team-chat/${dmId}`)
  ck("C29 a direct message left without members (404 now) is healed when either person opens it again: same chat, both members back", brokenGet.status === 404 && healed.status === 200 && healed.body.thread_id === dmId && healedGet.status === 200 && Number((await db.query("select count(*) from marketing_chat_thread_members where thread_id=$1", [dmId])).rows[0].count) === 2, { brokenGet: brokenGet.status, healed, healedGet: healedGet.status })

  // ---- editing a message to name someone counts as a mention (and taking the name out stops it)
  const plainMsg = (await db.query("select id from marketing_team_messages where thread_id=$1 and sender_id=$2 and deleted_at is null order by created_at limit 1", [dmId, ids.setterA])).rows[0]?.id as string | undefined
  const wr = await api(sp, "POST", `/api/marketing/team-chat/${dmId}/messages`, { message: "plain note to start" })
  const mid = wr.body.message?.id as string
  const e1 = await api(sp, "PATCH", `/api/marketing/team-chat/messages/${mid}`, { message: `now naming @${OWN}` })
  const m3 = (await db.query("select mentions from marketing_team_messages where id=$1", [mid])).rows[0]
  const e2 = await api(sp, "PATCH", `/api/marketing/team-chat/messages/${mid}`, { message: "name taken out again" })
  const m4 = (await db.query("select mentions from marketing_team_messages where id=$1", [mid])).rows[0]
  ck("C30 an edit that names someone stores the mention, and an edit that takes the name out clears it", e1.status === 200 && (m3.mentions as string[]).includes(ids.ownerA) && e2.status === 200 && (m4.mentions as string[]).length === 0 && !!plainMsg, { m3, m4 })

  // ---- a person who is in a conversation but is not on the team list (Antonio under View as is one) is shown by name, not as "Chat"
  const guestKey = [ids.setterA, ids.admin].sort().join(":")
  const gt = (await db.query("insert into marketing_chat_threads (team_id, kind, dm_key, created_by) values ($1,'dm',$2,$3) returning id", [teamA.id, guestKey, ids.admin])).rows[0].id as string
  await db.query("insert into marketing_chat_thread_members (thread_id, user_id) values ($1,$2),($1,$3)", [gt, ids.setterA, ids.admin])
  const listWithGuest = await api(sp, "GET", "/api/marketing/team-chat/threads")
  const guestRow = (listWithGuest.body.threads as Array<{ id: string; title: string }>).find(x => x.id === gt)
  ck("C31 a conversation with a person who is not on the team list is titled with that person's name (not 'Chat')", !!guestRow && guestRow.title === "Qa Cl Admin", guestRow)

  // ---- the lists never mix teams or people
  const mp = await open(marco)
  const tList = await api(mp, "GET", "/api/marketing/team-chat/threads")
  ck("C28 a person's list holds only the chats she is in (the setter's direct message with the owner is not in Marco's list)", !(tList.body.threads as Array<{ id: string }>).some(x => x.id === dmId))

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
