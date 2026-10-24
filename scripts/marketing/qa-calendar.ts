/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, round 2 step 2: the Calendar views): proves Day / Week / Month / Pipeline, drag-to-move with a REQUIRED
   reason, the Move button, past times refused, and what is written, through the REAL login page, dev server and database.
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa` running on :3010.
   Run: npx tsx scripts/marketing/qa-calendar.ts */
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








  const G = await import("@/lib/marketing/calendar-grid")
  const todayKey = G.romeParts(new Date().toISOString())!.key
  const nextMon = G.addDays(G.weekStart(todayKey), 7)
  const dayOf = (off: number) => G.addDays(nextMon, off)
  const slot = (key: string, h: number, m = 0) => G.slotIso(key, h, m)!
  const mkLead = async (n: string, name: string, cbIso: string | null, claimed: string | null = null) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, callback_at, claimed_by, claimed_by_label, answers) values ($1,$2,$3,$4,'+393339990000','contacted','Ad Alpha', now() - interval '30 days', $5::timestamptz, $6, $7, '[]'::jsonb) returning id", [teamA.id, `qcl-${n}`, name, `qcl${n}@example.test`, cbIso, claimed, claimed ? em("ownerA") : null])).rows[0].id as string
  const cb = (lead: string, actor: string) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,'status_changed',$2,$3, now() - interval '1 hour')", [lead, actor, JSON.stringify({ from: "new", to: "contacted", outcome: "call_back" })])
  const appt = (lead: string, actor: string, iso: string) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,'appointment',$2,$3, now() - interval '2 hours')", [lead, actor, JSON.stringify({ at: iso })])
  const L1 = await mkLead("1", "Week Appt Lead", null, ids.ownerA); await appt(L1, em("setterA"), slot(nextMon, 11))
  const L2 = await mkLead("2", "Week Callback Lead", slot(dayOf(1), 10)); await cb(L2, em("setterA"))
  const L3 = await mkLead("3", "Late Callback Lead", new Date(Date.now() - 3 * 86400000).toISOString()); await cb(L3, em("setterA"))
  const L4 = await mkLead("4", "Done Call Lead", null, ids.ownerA); await appt(L4, em("setterA"), new Date(Date.now() - 5 * 86400000).toISOString())
  const L6 = await mkLead("6", "Tomorrow Appt Lead", null, ids.ownerA); await appt(L6, em("setterA"), slot(G.addDays(todayKey, 1), 11))
  const L7 = await mkLead("7", "Later Appt Lead", null, ids.ownerA); await appt(L7, em("setterA"), slot(G.addDays(nextMon, 14), 16))
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









  const body = (page: import("playwright").Page) => page.locator("body").innerText().then(t => t.replace(/\s+/g, " "))
  const owner = await session(em("ownerA")), setter = await session(em("setterA"))
  type Pg = import("playwright").Page
  const lastAppt = async (lead: string) => (await db.query("select data, actor from marketing_lead_events where lead_id=$1 and kind='appointment' order by created_at desc limit 1", [lead])).rows[0]
  const apptCount = async (lead: string) => Number((await db.query("select count(*) from marketing_lead_events where lead_id=$1 and kind='appointment'", [lead])).rows[0].count)
  // a toast stays about 4 s: wait for the NEW one, read it, then wait for it to go so the next step never reads the old one
  const waitToast = async (p: Pg) => { await p.getByTestId("cal-toast").waitFor({ timeout: 60000 }); const t = await p.getByTestId("cal-toast").innerText(); await p.getByTestId("cal-toast").waitFor({ state: "detached", timeout: 15000 }); return t }
  const dragTo = async (p: Pg, src: string, target: string, y?: number) => {
    const col = p.locator(target)
    const box = (await col.boundingBox())!
    await p.locator(src).first().dragTo(col, { targetPosition: { x: Math.max(4, box.width / 2), y: y ?? Math.min(box.height / 2, 40) } })
  }
  const NEXT = "[data-testid=cal-next]"

  // ---- the week
  const page = await owner.newPage()
  await page.goto(BASE + "/marketing/calendar", { waitUntil: "networkidle", timeout: 180000 })
  await page.getByTestId("cal-view-week").click()
  await page.locator(NEXT).click()
  await page.waitForTimeout(500)
  const colMon = `[data-testid=cal-col][data-day="${nextMon}"]`
  ck("V1 Rocco's week (next week) shows the booked call on Monday and the call back on Tuesday, each in its own day", (await page.locator(`${colMon} [data-lead="${L1}"]`).count()) === 1 && (await page.locator(`[data-testid=cal-col][data-day="${dayOf(1)}"] [data-lead="${L2}"]`).count()) === 1)
  await page.screenshot({ path: `${SHOTS}/qa-cal-week.png`, fullPage: true })

  // drag the booked call from Monday 11:00 to Wednesday ~15:00
  const wedY = (await page.locator(`[data-testid=cal-col][data-day="${dayOf(2)}"]`).boundingBox())!.height * ((15 - 8) / 13) + 2
  await dragTo(page, `${colMon} [data-lead="${L1}"]`, `[data-testid=cal-col][data-day="${dayOf(2)}"]`, wedY)
  await page.getByTestId("move-dialog").waitFor({ timeout: 30000 })
  ck("V2 dropping a call on another day opens the 'Why is this call moving?' box, and Move the call stays OFF until a reason is picked", (await page.getByTestId("move-save").isDisabled()) === true && /Why is this call moving/.test(await body(page)))
  const before = await apptCount(L1)
  ck("V3b still one booking row before the reason is given", before === 1)
  await page.getByTestId("move-reason").first().click()
  ck("V4 picking a reason switches Move the call on", (await page.getByTestId("move-save").isDisabled()) === false)
  await page.getByTestId("move-save").click()
  const t1 = await waitToast(page)
  ck("V5 the screen says it moved and that the seller and the setter were told", /Moved\. The seller and the setter were told/.test(t1), t1)
  const a1 = await lastAppt(L1)
  ck("V6 a NEW booking row was written at Wednesday 15:00 Rome time with the reason, the old time, and moved=true, by the person who moved it", a1.data.at === slot(dayOf(2), 15) && a1.data.reason === "The lead asked to move" && a1.data.rescheduled === true && a1.data.from === slot(nextMon, 11) && a1.actor === em("ownerA") && (await apptCount(L1)) === 2, a1)
  await page.waitForTimeout(1500)
  ck("V7 after the refresh the call sits in the Wednesday column and no longer in Monday's", (await page.locator(`[data-testid=cal-col][data-day="${dayOf(2)}"] [data-lead="${L1}"]`).count()) === 1 && (await page.locator(`${colMon} [data-lead="${L1}"]`).count()) === 0)

  // the Move button, typed time, "Other" needs words
  await page.locator(`[data-testid=cal-col][data-day="${dayOf(1)}"] [data-lead="${L2}"] [data-testid=cal-move]`).click()
  await page.getByTestId("move-dialog").waitFor({ timeout: 30000 })
  await page.getByTestId("move-when").fill(`${dayOf(3)}T12:00`)
  await page.getByTestId("move-reason").last().click()
  ck("V8 'Other' needs a few words: Move the call stays off until they are typed", (await page.getByTestId("move-save").isDisabled()) === true)
  await page.getByTestId("move-note").fill("she travels on Tuesday")
  await page.getByTestId("move-save").click()
  await waitToast(page)
  const l2 = (await db.query("select callback_at, status from marketing_leads where id=$1", [L2])).rows[0]
  const e2 = (await db.query("select actor, data from marketing_lead_events where lead_id=$1 and kind='status_changed' order by created_at desc limit 1", [L2])).rows[0]
  ck("V9 the call back moved to Thursday 12:00 Rome with the reason and the note, and the lead keeps its stage", new Date(l2.callback_at).toISOString() === slot(dayOf(3), 12) && e2.data.rescheduled === true && e2.data.reason === "Other" && e2.data.note === "she travels on Tuesday" && l2.status === "contacted", { l2, e2 })
  await page.close()

  // the history on the lead says it in plain words
  const hv = await owner.newPage()
  await hv.goto(`${BASE}/marketing/window/${L1}`, { waitUntil: "networkidle", timeout: 180000 })
  ck("V10 the lead's history says 'Call moved to … Reason: The lead asked to move'", /Call moved to .* Reason: The lead asked to move/.test(await body(hv)))
  await hv.close()

  // the setter still owns the call back Rocco moved
  const sv = await setter.newPage()
  await sv.goto(BASE + "/marketing/calendar", { waitUntil: "networkidle", timeout: 180000 })
  await sv.getByTestId("cal-view-week").click(); await sv.locator(NEXT).click(); await sv.waitForTimeout(500)
  ck("V11 the setter (who set the call back) still sees it after Rocco moved it, at its new time, and has the Move button too", (await sv.locator(`[data-testid=cal-col][data-day="${dayOf(3)}"] [data-lead="${L2}"]`).count()) === 1 && (await sv.locator(`[data-lead="${L2}"] [data-testid=cal-move]`).count()) === 1)
  await sv.close()

  // ---- the month: past days refuse
  const mv = await owner.newPage()
  await mv.goto(BASE + "/marketing/calendar", { waitUntil: "networkidle", timeout: 180000 })
  await mv.getByTestId("cal-view-month").click()
  await mv.waitForTimeout(400)
  await mv.screenshot({ path: `${SHOTS}/qa-cal-month.png`, fullPage: true })
  const yesterday = G.addDays(todayKey, -1)
  const lateChip = mv.locator(`[data-testid=cal-cell] [data-lead="${L3}"]`)
  if ((await lateChip.count()) === 1 && (await mv.locator(`[data-testid=cal-cell][data-day="${yesterday}"]`).count()) === 1) {
    await lateChip.first().dragTo(mv.locator(`[data-testid=cal-cell][data-day="${yesterday}"]`))
    const tp = await waitToast(mv)
    ck("V12 dragging a call to a day that has passed is refused with a message and NO box opens", /already passed/.test(tp) && (await mv.getByTestId("move-dialog").count()) === 0, tp)
  } else ck("V12 (skipped: the late call or yesterday is not in this month's grid)", true)
  // a drop on a future day (month): the same time of day is kept
  const tmrKey = G.addDays(todayKey, 1)
  const tomChip = mv.locator(`[data-testid=cal-cell] [data-lead="${L6}"]`)
  const wasAt = (await lastAppt(L6)).data.at as string
  const target = G.addDays(todayKey, 2)
  if ((await tomChip.count()) === 1 && (await mv.locator(`[data-testid=cal-cell][data-day="${target}"]`).count()) === 1) {
    await tomChip.first().dragTo(mv.locator(`[data-testid=cal-cell][data-day="${target}"]`))
    await mv.getByTestId("move-dialog").waitFor({ timeout: 30000 })
    await mv.getByTestId("move-reason").nth(1).click(); await mv.getByTestId("move-save").click(); await waitToast(mv)
    const a6 = await lastAppt(L6)
    ck("V13 a drop on another day in the month keeps the time of day (11:00) and records the reason", a6.data.at === G.moveToDay(wasAt, target) && a6.data.reason === "The seller is not available", { a6, wasAt })
  } else ck("V13 (skipped: not in the grid)", true, tmrKey)
  await mv.close()

  // ---- the pipeline
  const pv = await owner.newPage()
  await pv.goto(BASE + "/marketing/calendar", { waitUntil: "networkidle", timeout: 180000 })
  await pv.getByTestId("cal-view-pipeline").click()
  await pv.waitForTimeout(400)
  const inBucket = async (b: string) => (await pv.locator(`[data-bucket="${b}"]`).innerText()).replace(/\s+/g, " ")
  ck("V14 'By when' has the five groups, with the late call back in Late and the far call in Later; the call that already happened is not there", (await pv.locator("[data-bucket]").count()) === 5 && /Late Callback Lead/.test(await inBucket("late")) && /Later Appt Lead/.test(await inBucket("later")) && !/Done Call Lead/.test(await body(pv)))
  await pv.screenshot({ path: `${SHOTS}/qa-cal-pipeline.png`, fullPage: true })
  await pv.locator(`[data-bucket="later"] [data-lead="${L7}"]`).first().dragTo(pv.locator('[data-bucket="late"]'))
  const tl = await waitToast(pv)
  ck("V15 dropping a card into Late is refused with a message", /cannot be moved into Late/.test(tl) && (await pv.getByTestId("move-dialog").count()) === 0, tl)
  const n7 = await apptCount(L7)
  await pv.locator(`[data-bucket="later"] [data-lead="${L7}"]`).first().dragTo(pv.locator('[data-bucket="tomorrow"]'))
  await pv.getByTestId("move-dialog").waitFor({ timeout: 30000 })
  await pv.keyboard.press("Escape")
  await pv.waitForTimeout(300)
  ck("V16 closing the box without a reason writes nothing", (await apptCount(L7)) === n7 && (await pv.getByTestId("move-dialog").count()) === 0)
  await pv.locator(`[data-bucket="later"] [data-lead="${L7}"]`).first().dragTo(pv.locator('[data-bucket="tomorrow"]'))
  await pv.getByTestId("move-dialog").waitFor({ timeout: 30000 })
  await pv.getByTestId("move-reason").nth(3).click(); await pv.getByTestId("move-save").click(); await waitToast(pv)
  const a7 = await lastAppt(L7)
  ck("V17 dropping on Tomorrow keeps the time of day (16:00) and writes tomorrow", a7.data.at === G.moveToDay(slot(G.addDays(nextMon, 14), 16), G.addDays(todayKey, 1)) && a7.data.reason === "The lead did not answer", a7)
  await pv.getByTestId("pipe-stage").click()
  await pv.waitForTimeout(300)
  ck("V18 'By stage' has four columns; the call that happened is in 'Call done', the call back in 'Call back later'", (await pv.locator("[data-stage]").count()) === 4 && /Done Call Lead/.test((await pv.locator('[data-stage="done"]').innerText())) && /Week Callback Lead/.test((await pv.locator('[data-stage="back"]').innerText())))
  await pv.close()

  // ---- the server itself refuses an empty reason or a past time
  const sp = await owner.newPage()
  await sp.goto(BASE + "/marketing/calendar", { waitUntil: "networkidle", timeout: 180000 })
  const post = (payload: object) => sp.evaluate(async ([id, p]) => { const r = await fetch(`/api/marketing/leads/${id}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }); return { status: r.status, body: await r.json().catch(() => ({})) } }, [L1, payload] as const)
  const noReason = await post({ action: "reschedule", target: "appointment", at: slot(dayOf(4), 10), reason: "" })
  const past = await post({ action: "reschedule", target: "appointment", at: new Date(Date.now() - 86400000).toISOString(), reason: "x" })
  ck("V19 the server refuses a move with no reason (400) and a move into the past (400, clear message)", noReason.status === 400 && past.status === 400 && /already passed/.test(past.body.error ?? ""), { noReason, past })
  await sp.close()

  // ---- Day view
  const dv = await owner.newPage()
  await dv.goto(BASE + "/marketing/calendar", { waitUntil: "networkidle", timeout: 180000 })
  await dv.getByTestId("cal-view-day").click()
  await dv.waitForTimeout(300)
  ck("V20 the Day view shows one column with a title for that day, and the arrows move by one day", (await dv.locator("[data-testid=cal-col]").count()) === 1 && /\d{4}/.test(await dv.getByTestId("cal-title").innerText()))
  await dv.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
