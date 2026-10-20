/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Slice 2a): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-setter.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3011"
const PASS = "Qa-setter-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-setter-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qs-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qs-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA setter %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-setter-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA setter A ${stamp}`, actor: "qa-setter" })).data!
  const teamB = (await S.createTeam({ name: `QA setter B ${stamp}`, actor: "qa-setter" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-setter"); await S.setTeamStatus(teamB.id, "active", "qa-setter")
  await S.setMarketingSetting({ key: "qualification_checklist", value: ["Has a business", "Wants to open an LLC", "Can talk this week"], actor: "qa-setter", teamId: teamA.id })
  await S.setMarketingSetting({ key: "permission_bundles", value: { setter: ["leads.read", "leads.call", "leads.mark", "chat"], reader: ["leads.read"] }, actor: "qa-setter", teamId: teamA.id })
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-setter", permissions: [] as string[] }
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
  await mk("ownerA", teamA.id, "owner"); await mk("ownerB", teamB.id, "owner"); await mk("setterA", teamA.id, "member", "setter"); await mk("readerA", teamA.id, "member", "reader")
  const seedLead = async (n: string, name: string, team: string) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, phone, answers) values ($1,$2,$3,'+393331112233','[]'::jsonb) returning id", [team, `qs-${n}`, name])).rows[0].id as string
  const L: Record<string, string> = {}
  for (const [n, name] of [["1", "Lead One"], ["2", "Lead Two"], ["3", "Lead Three"], ["4", "Lead Four"]]) L[n] = await seedLead(n, name, teamA.id)
  L.B = await seedLead("B", "Team B Lead", teamB.id)

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
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } })
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
  const lead = async (n: string) => (await db.query("select * from marketing_leads where id=$1", [L[n]])).rows[0]
  const events = async (n: string) => (await db.query("select kind, actor, data from marketing_lead_events where lead_id=$1 order by created_at, id", [L[n]])).rows
  const api = (ctx: BrowserContext, id: string, body: unknown) => ctx.request.post(`${BASE}/api/marketing/leads/${id}/action`, { data: body }).then(async r => ({ status: r.status(), json: await r.json().catch(() => ({})) }))

  const setter = await session(em("setterA"))
  const owner = await session(em("ownerA"))
  const ownerB = await session(em("ownerB"))
  const reader = await session(em("readerA"))

  // ── the setter, in the browser (phone-sized) ──
  let v = await view(setter, `/marketing/leads/${L["1"]}`)
  const has = (re: RegExp) => re.test(v.text)
  ck("E1 the setter sees Good / Not in target / Call back later / note, and NO 'Pick this lead'", has(/Good/) && has(/Not in target/) && has(/Call back later/) && has(/Add a note/) && !has(/Pick this lead/), v.text.slice(0, 700))
  await v.page.getByRole("button", { name: "Not in target" }).click()
  const saveBtn = v.page.getByRole("button", { name: "Save" })
  ck("E2 'Save' stays off until a reason is chosen", await saveBtn.isDisabled())
  await v.page.locator("select").selectOption("lives_in_italy_no_business")
  await v.page.locator("textarea").fill("Said he only wants an Italian company")
  await saveBtn.click()
  await v.page.getByText("Reason: Lives in Italy, no business").waitFor({ timeout: 60000 })
  const l1 = await lead("1")
  ck("E3 Not in target is saved: stage, reason, and a history row with who and why", l1.status === "not_in_target" && l1.not_in_target_reason === "lives_in_italy_no_business", l1)
  const ev1 = await events("1")
  ck("E4 the history row names the setter and keeps the note", ev1.length === 1 && ev1[0].kind === "status_changed" && ev1[0].actor === em("setterA") && ev1[0].data.note === "Said he only wants an Italian company" && ev1[0].data.from === "new", ev1)
  await v.page.screenshot({ path: `${SHOTS}/qa-setter-notintarget.png`, fullPage: true }); await v.page.close()

  v = await view(setter, `/marketing/leads/${L["2"]}`)
  await v.page.getByRole("button", { name: "Call back later" }).click()
  const when = new Date(Date.now() + 26 * 3600 * 1000); const pad = (x: number) => String(x).padStart(2, "0")
  const local = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:00`
  ck("E5 'Save' stays off until a day and time are chosen", await v.page.getByRole("button", { name: "Save" }).isDisabled())
  await v.page.locator('input[type="datetime-local"]').fill(local)
  await v.page.getByRole("button", { name: "Save" }).click()
  await v.page.getByText(/Call back on/).first().waitFor({ timeout: 60000 })
  const l2 = await lead("2")
  ck("E6 Call back later saves the time and moves to the configured stage", l2.status === "contacted" && !!l2.callback_at && Math.abs(new Date(l2.callback_at).getTime() - new Date(local).getTime()) < 60000, l2)
  await v.page.close()

  // a time in the past is refused with the server's own sentence, shown on screen
  v = await view(setter, `/marketing/leads/${L["3"]}`)
  await v.page.getByRole("button", { name: "Call back later" }).click()
  await v.page.locator('input[type="datetime-local"]').fill("2020-01-01T10:00")
  await v.page.getByRole("button", { name: "Save" }).click()
  const alertBox = v.page.locator("p[role=alert]")   // (Next.js has its own empty role=alert announcer, so be specific)
  await alertBox.waitFor({ timeout: 60000 })
  ck("E7 a call-back in the past is refused and the reason is shown", /already passed/.test(await alertBox.innerText()) && (await lead("3")).status === "new", await alertBox.innerText())
  await v.page.close()

  // ── the owner picks; the setter is then locked out of that lead ──
  v = await view(owner, `/marketing/leads/${L["3"]}`)
  ck("E8 the owner sees 'Pick this lead'", /Pick this lead/.test(v.text), v.text.slice(0, 400))
  await v.page.getByRole("button", { name: "Pick this lead" }).click()
  await v.page.getByText("You picked this lead.").waitFor({ timeout: 60000 })
  const l3 = await lead("3")
  ck("E9 picking records the owner and when", l3.claimed_by === ids.ownerA && l3.claimed_by_label === em("ownerA") && !!l3.claimed_at, l3)
  await v.page.screenshot({ path: `${SHOTS}/qa-setter-owner-picked.png`, fullPage: true }); await v.page.close()
  v = await view(setter, `/marketing/leads/${L["3"]}`)
  ck("E10 the setter now sees it is picked by someone else and has no action buttons", /Someone else picked this lead/.test(v.text) && !/Not in target/.test(v.text.replace(/Someone else[^.]*\./, "")) , v.text.slice(0, 600)); await v.page.close()
  const refused = await api(setter, L["3"], { action: "note", note: "sneaky" })
  ck("E11 the same refusal when the setter calls the server directly (409), nothing written", refused.status === 409 && (await events("3")).filter(e => e.kind === "note").length === 0, refused)

  // ── two people picking the same free lead at the same moment ──
  const [r1, r2] = await Promise.all([api(owner, L["4"], { action: "claim" }), api(setter, L["4"], { action: "claim" })])
  ck("E12 the setter cannot pick at all (no pick permission): 403", r2.status === 403, r2)
  ck("E13 the owner's pick works, and the lead has exactly one picker", r1.status === 200 && (await lead("4")).claimed_by === ids.ownerA, [r1, r2])

  // ── the owner works a lead and ticks the checklist ──
  v = await view(owner, `/marketing/leads/${L["3"]}`)
  await v.page.getByRole("button", { name: "Good" }).click()
  await v.page.getByLabel("Has a business").check(); await v.page.getByLabel("Can talk this week").check()
  await v.page.locator("textarea").fill("Ready for the free call")
  await v.page.getByRole("button", { name: "Save" }).click()
  await v.page.getByText("Checklist from the call").waitFor({ timeout: 60000 })
  const l3b = await lead("3")
  ck("E14 Good saves the ticks (and the untick), the stage, and clears any call-back", l3b.status === "qualified" && JSON.stringify(l3b.qualification) === JSON.stringify([{ item: "Has a business", ticked: true }, { item: "Wants to open an LLC", ticked: false }, { item: "Can talk this week", ticked: true }]), l3b)
  const body = await v.page.locator("body").innerText()
  ck("E15 the page shows the checklist result and the history in plain English", /✔ Has a business/.test(body) && /✘ Wants to open an LLC/.test(body) && /Good — moved to Qualified — Ready for the free call/.test(body) && /Picked/.test(body), body.slice(0, 1200))
  await v.page.screenshot({ path: `${SHOTS}/qa-setter-good.png`, fullPage: true }); await v.page.close()

  // ── give back ──
  const rel = await api(owner, L["3"], { action: "release" })
  ck("E16 the owner gives the lead back; it is free again and the history says so", rel.status === 200 && (await lead("3")).claimed_by === null && (await events("3")).some(e => e.kind === "released"), rel)

  // ── another team, and a reader ──
  const cross = await api(ownerB, L["1"], { action: "note", note: "from team B" })
  ck("E17 another team's owner cannot touch team A's lead (404, nothing written)", cross.status === 404 && (await events("1")).filter(e => e.kind === "note").length === 0, cross)
  const crossB = await api(owner, L.B, { action: "claim" })
  ck("E18 and team A's owner cannot pick team B's lead", crossB.status === 404 && (await lead("B")).claimed_by === null, crossB)
  const rd = await api(reader, L["1"], { action: "note", note: "reader" })
  ck("E19 a member who may only read gets 403 on every action", rd.status === 403, rd)
  v = await view(reader, `/marketing/leads/${L["1"]}`)
  ck("E20 and his page has no action buttons at all", !/What to do with this lead[\s\S]*(Good|Not in target)/.test(v.text.split("What they answered")[0].replace(/Not in target\s*$/m, "")) || !/Call back later/.test(v.text), v.text.slice(0, 500)); await v.page.close()
  const bad = await api(owner, L["1"], { action: "not_in_target", reason: "made_up" })
  ck("E21 a reason that is not in the list is refused (400)", bad.status === 400, bad)
  const junk = await api(owner, L["1"], { action: "delete" })
  ck("E22 an unknown action is refused (400)", junk.status === 400, junk)
  const anon = await browser.newContext()
  const an = await anon.request.post(`${BASE}/api/marketing/leads/${L["1"]}/action`, { data: { action: "claim" }, maxRedirects: 0 })
  ck("E23 with no login the server refuses (401/403/redirect)", [401, 403, 307, 308, 302].includes(an.status()), an.status())

  // ── the filtered list ──
  v = await view(owner, "/marketing/leads?show=callbacks")
  ck("E24 'Call backs' shows only the lead with a call-back time", /Lead Two/.test(v.text) && !/Lead Four/.test(v.text) && /Call back/.test(v.text), v.text.slice(0, 600)); await v.page.close()
  v = await view(owner, "/marketing/leads?show=mine")
  ck("E25 'Picked by me' shows the owner's pick (lead four) and not the free ones", /Lead Four/.test(v.text) && !/Lead Two/.test(v.text) && !/Lead Three/.test(v.text), v.text.slice(0, 600)); await v.page.close()
  v = await view(owner, "/marketing/leads?show=free&stage=new")
  ck("E26 'Not picked yet' + stage 'New' shows none of the worked leads", !/Lead One|Lead Two|Lead Four/.test(v.text), v.text.slice(0, 600)); await v.page.close()
  v = await view(owner, "/marketing/leads?stage=not_in_target")
  ck("E27 stage filter shows only that stage", /Lead One/.test(v.text) && !/Lead Two/.test(v.text), v.text.slice(0, 400))
  await v.page.screenshot({ path: `${SHOTS}/qa-setter-list.png`, fullPage: true }); await v.page.close()
  v = await view(owner, "/marketing/leads?show=bogus&stage=bogus")
  ck("E28 nonsense filters fall back to the full list without an error", v.status === 200 && /Lead One/.test(v.text) && /Lead Four/.test(v.text), v.text.slice(0, 300)); await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
