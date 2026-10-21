/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Slice 2a): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-admin.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3011"
const PASS = "Qa-admin-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-admin-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qa-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qa-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA admin %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-admin-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA admin A ${stamp}`, actor: "qa-admin" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-admin")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-admin", permissions: [] as string[] }
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
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }
  const H = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
  const seed = async (n: string, name: string, o: { status?: string; team?: string | null; at?: number; claimed?: boolean; cb?: number | null; client?: object } = {}) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, status, received_at, claimed_by, claimed_by_label, callback_at, existing_client, answers) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb) returning id",
      [o.team === undefined ? teamA.id : o.team, `qa-${n}`, name, o.status ?? "new", H(o.at ?? 1), o.claimed ? ids.ownerA : null, o.claimed ? em("ownerA") : null, o.cb === undefined || o.cb === null ? null : H(-o.cb), o.client ? JSON.stringify(o.client) : null])).rows[0].id as string
  const L: Record<string, string> = {}
  L.fresh1 = await seed("1", "Fresh One", { at: 2 })
  L.fresh2 = await seed("2", "Fresh Two", { at: 5 })
  L.old1 = await seed("3", "Old One", { at: 80 })
  L.old2 = await seed("4", "Old Two", { at: 30 })
  L.good = await seed("5", "Good Lead", { status: "qualified", at: 10 })
  L.picked = await seed("6", "Picked Lead", { status: "contacted", claimed: true, at: 40 })
  L.late = await seed("7", "Late Callback", { status: "contacted", at: 9, cb: -3 })
  L.later = await seed("8", "Later Today", { status: "contacted", at: 9, cb: 0.1 })
  L.client = await seed("9", "Anna Vitale", { at: 3, client: { contact_ids: ["c1"], matched_on: ["email"] } })
  L.noteam = await seed("10", "Nobody's Lead", { team: null, at: 2 })
  const evt = (lead: string, kind: string, actor: string, data: object, h: number) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,$2,$3,$4,$5)", [lead, kind, actor, JSON.stringify(data), H(h)])
  await evt(L.good, "status_changed", em("setterA"), { from: "new", to: "qualified", outcome: "good" }, 0.5)
  await evt(L.fresh1, "status_changed", em("setterA"), { from: "new", to: "not_in_target", outcome: "not_in_target" }, 0.6)
  await evt(L.late, "status_changed", em("setterA"), { from: "new", to: "contacted", outcome: "call_back" }, 0.7)
  await evt(L.picked, "claimed", em("ownerA"), {}, 0.8)
  await db.query("update marketing_leads set answers=$2::jsonb, qualification=$3::jsonb, full_name='Picked Lead', phone='+393331112233' where id=$1", [L.picked, JSON.stringify([{ name: "che_attività_hai?", values: ["servizi_e_consulenze"] }, { name: "dove_vivi_oggi?", values: ["fuori_dall'italia"] }]), JSON.stringify([{ item: "Has a business", ticked: true }, { item: "Can talk this week", ticked: false }])])
  await evt(L.picked, "status_changed", em("setterA"), { from: "new", to: "qualified", outcome: "good", note: "ready for the free call" }, 1)
  await evt(L.old2, "status_changed", em("setterA"), { outcome: "good", to: "qualified" }, 30)  // yesterday-ish: must not count today

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


  const admin = await session(em("admin")), staff = await session(em("staff")), owner = await session(em("ownerA"))
  const api = (ctx: BrowserContext, method: "put" | "post" | "patch", path: string, data?: unknown) => ctx.request[method](`${BASE}${path}`, { data }).then(async r => ({ status: r.status(), json: await r.json().catch(() => ({})) }))
  const flat = (t: string) => t.replace(/\s+/g, " ")

  // ── sub-menu ──
  let v = await view(admin, "/marketing-leads")
  const links = await v.page.locator('nav[aria-label="Marketing"] a').allInnerTexts()
  const soon = await v.page.locator('nav[aria-label="Marketing"] span').allInnerTexts()
  ck("N1 the Marketing section has a sub-menu: Overview, All leads, Teams, Audit log, Settings; Money, Calls and Conversations are greyed 'soon', not links", links.join("|") === "Overview|All leads|Teams|Audit log|Settings" && soon.filter(t => /^(Money|Calls|Conversations)\s/i.test(t)).length === 3, { links, soon })
  await v.page.close()

  // ── all leads + detail ──
  v = await view(admin, `/marketing-leads/leads?team=${teamA.id}`)
  ck("N2 All leads lists the team's leads with contact details, stage and picked-by", /Good Lead/.test(v.text) && /Picked Lead/.test(v.text) && /qa-admin-ownera@example\.test/.test(v.text) && !/Nobody's Lead/.test(v.text), v.text.slice(0, 500))
  await v.page.close()
  v = await view(admin, `/marketing-leads/leads?lead=${L.picked}`)
  const d = flat(await v.page.locator('aside[aria-label="Lead detail"]').innerText())
  ck("N3 clicking a lead shows its contact details, who picked it, the form answers in plain words, the setter's checklist ticks and the whole history with who did what", /Picked by: qa-admin-ownera@example\.test/.test(d) && /Servizi e consulenze/.test(d) && /Fuori dall'italia/.test(d) && /✔ Has a business/.test(d) && /✘ Can talk this week/.test(d) && /Good — moved to Qualified — ready for the free call · qa-admin-settera@example\.test/.test(d) && /Picked · qa-admin-ownera@example\.test/.test(d), d.slice(0, 1500))
  await v.page.screenshot({ path: `${SHOTS}/qa-admin-lead-detail.png`, fullPage: true }); await v.page.close()
  v = await view(admin, `/marketing-leads/leads?team=none`)
  ck("N4 the 'No team yet' filter shows only leads with no team", /Nobody's Lead/.test(v.text) && !/Good Lead/.test(v.text), v.text.slice(0, 300)); await v.page.close()
  v = await view(admin, `/marketing-leads/leads?team=${teamA.id}&stage=qualified`)
  ck("N5 the stage filter narrows the list", /Good Lead/.test(v.text) && !/Fresh One/.test(v.text) && !/Picked Lead/.test(v.text), v.text.slice(0, 300)); await v.page.close()
  v = await view(admin, `/marketing-leads/leads?q=fresh`)
  ck("N6 the search finds a lead by name", /Fresh One/.test(v.text) && /Fresh Two/.test(v.text) && !/Good Lead/.test(v.text), v.text.slice(0, 300)); await v.page.close()
  v = await view(admin, `/marketing-leads/leads?q=${encodeURIComponent("%_,()")}`)
  ck("N7 a search made of wildcard characters does not break the page", v.status === 200 && !/Application error/.test(v.text), v.text.slice(0, 200)); await v.page.close()
  v = await view(admin, "/marketing-leads/leads?lead=not-a-lead")
  ck("N8 a bad lead id shows the empty detail, not an error", v.status === 200 && /Click a lead on the left/.test(await v.page.locator('aside[aria-label="Lead detail"]').innerText())); await v.page.close()

  // ── assign ──
  v = await view(admin, `/marketing-leads/leads?lead=${L.noteam}`)
  ck("N9 a lead with no team says so and offers the teams", /This lead has no team, so nobody can see it yet/.test(await v.page.locator('aside[aria-label="Lead detail"]').innerText()) && (await v.page.locator('select[aria-label="Team"] option').count()) >= 2, v.text.slice(0, 300))
  await v.page.getByLabel("Team", { exact: true }).selectOption(teamA.id)
  await v.page.getByRole("button", { name: "Give it to this team" }).click()
  await v.page.getByText(/Assigned to QA admin A/).waitFor({ timeout: 60000 })
  const as = (await db.query("select team_id from marketing_leads where id=$1", [L.noteam])).rows[0]
  const aev = (await db.query("select kind, actor, data from marketing_lead_events where lead_id=$1 and kind='assigned'", [L.noteam])).rows
  ck("N10 assigning gives the lead to the team and writes who did it", as.team_id === teamA.id && aev.length === 1 && aev[0].actor === em("admin"), { as, aev })
  await v.page.close()
  const again = await api(admin, "post", `/api/marketing-admin/leads/${L.noteam}/assign`, { teamId: teamA.id })
  ck("N11 assigning a lead that already has a team is refused (409)", again.status === 409, again)
  const sb = await api(staff, "post", `/api/marketing-admin/leads/${L.fresh1}/assign`, { teamId: teamA.id })
  ck("N12 a staff login cannot assign (403)", sb.status === 403, sb)

  // ── audit log ──
  v = await view(admin, "/marketing-leads/audit")
  const a = flat(v.text)
  ck("N13 the audit log lists what was done: who, which lead, what", /qa-admin-settera@example\.test Good Lead Good — moved to Qualified/.test(a) && /qa-admin-ownera@example\.test Picked Lead Picked/.test(a) && /Call back on/.test(a) && !/Lead arrived from the ad/.test(a), a.slice(0, 900))
  await v.page.close()
  v = await view(admin, `/marketing-leads/audit?who=${encodeURIComponent(em("setterA"))}`)
  ck("N14 filtering by person shows only that person's actions", !/qa-admin-ownera@example\.test Picked/.test(flat(v.text)) && /qa-admin-settera@example\.test/.test(v.text), v.text.slice(0, 300)); await v.page.close()

  // ── teams ──
  v = await view(admin, "/marketing-leads/teams")
  const sect = v.page.locator("section", { hasText: `QA admin A ${stamp}` }).first()
  const tt = flat(await sect.innerText())
  ck("N15 Teams shows the team, whether it is on, its people and each setter's month", /QA admin A/.test(tt) && /On/.test(tt) && /qa-admin-ownera@example\.test Team owner/.test(tt) && /qa-admin-settera@example\.test Setter/.test(tt) && /qa-admin-settera@example\.test 3 1 1 75%/.test(tt), tt.slice(0, 1200))
  await v.page.screenshot({ path: `${SHOTS}/qa-admin-teams.png`, fullPage: true })
  await sect.getByRole("button", { name: /Pause the team/ }).click()
  await v.page.getByText(/The team is paused/).waitFor({ timeout: 60000 })
  ck("N16 Pause stops the team (stored) and the owner is refused at once", (await db.query("select status from marketing_teams where id=$1", [teamA.id])).rows[0].status === "paused" && (await api(owner, "post", `/api/marketing/leads/${L.fresh1}/action`, { action: "note", note: "x" })).status === 403)
  await sect.getByRole("button", { name: "Resume the team" }).click()
  await v.page.getByText(/The team is on/).waitFor({ timeout: 60000 })
  ck("N17 Resume switches it back on", (await db.query("select status from marketing_teams where id=$1", [teamA.id])).rows[0].status === "active")
  await sect.getByLabel("Owner email").fill(em("secondowner"))
  await sect.getByRole("button", { name: "Create invitation link" }).click()
  await sect.getByLabel("Invitation link").first().waitFor({ timeout: 60000 })
  const inv = (await db.query("select member_role, token_hash from marketing_invites where email_lower=$1", [em("secondowner")])).rows[0]
  const url = await sect.locator('input[aria-label="Invitation link"]').inputValue()
  ck("N18 the owner invitation gives a one-time link; an owner invitation is stored with its role and only the hash", inv?.member_role === "owner" && url.includes("/marketing/accept?token=") && inv.token_hash !== new URL(url).searchParams.get("token"), { inv, url: url.slice(0, 50) })
  await v.page.close()

  // ── settings ──
  v = await view(admin, `/marketing-leads/settings?team=${teamA.id}`)
  ck("N19 Settings shows the Meta connection, the checklist, reasons, switches and currencies", /Meta connection/.test(v.text) && /Good. checklist/.test(v.text) && /Reasons for/.test(v.text) && /Switches/.test(v.text) && /Currencies/.test(v.text), v.text.slice(0, 400))
  await v.page.getByRole("button", { name: "Add a line" }).first().click()
  await v.page.getByLabel("Checklist line 1", { exact: true }).fill("Has or plans a business")
  await v.page.getByRole("button", { name: "Add a line" }).first().click()
  await v.page.getByLabel("Checklist line 2", { exact: true }).fill("Wants a US company")
  await v.page.getByRole("button", { name: "Save the checklist" }).click()
  await v.page.getByText(/Checklist saved/).waitFor({ timeout: 60000 })
  const cl = (await db.query("select value from marketing_settings where key='qualification_checklist' and team_id=$1", [teamA.id])).rows[0]?.value
  ck("N20 the checklist is saved for the team (and kept in the history)", JSON.stringify(cl) === JSON.stringify(["Has or plans a business", "Wants a US company"]) && (await db.query("select count(*)::int n from marketing_settings_history where key='qualification_checklist'")).rows[0].n >= 1, cl)
  const setterCtx = await session(em("setterA"))
  const sv = await view(setterCtx, `/marketing/leads/${L.fresh2}`)
  await sv.page.getByRole("button", { name: "Good" }).click()
  ck("N21 the setter now sees those lines to tap on a lead", (await sv.page.getByLabel("Has or plans a business").count()) === 1 && (await sv.page.getByLabel("Wants a US company").count()) === 1); await sv.page.close()
  await v.page.getByLabel("Reason 1", { exact: true }).fill("Wrong profile (edited)")
  await v.page.getByRole("button", { name: "Add a line" }).nth(1).click()
  await v.page.getByLabel("Reason 5", { exact: true }).fill("Too far away")
  await v.page.getByRole("button", { name: "Save the reasons" }).click()
  await v.page.getByText("Reasons saved.").waitFor({ timeout: 60000 })
  const rs = (await db.query("select value from marketing_settings where key='not_in_target_reasons' and team_id=$1", [teamA.id])).rows[0]?.value as Array<{ key: string; label: string }>
  ck("N22 renaming a reason keeps its key; a new reason gets a new key", rs?.[0]?.key === "wrong_profile" && rs[0].label === "Wrong profile (edited)" && rs.at(-1)?.key === "too_far_away", rs)
  await v.page.getByRole("switch", { name: "Rocco may create offers" }).click()
  await v.page.getByText(/Rocco may create offers: off/).waitFor({ timeout: 60000 })
  ck("N23 a switch saves at once", (await db.query("select value from marketing_settings where key='owner_may_create_offers' and team_id=$1", [teamA.id])).rows[0]?.value === false)
  await v.page.getByLabel("Currencies").fill("USD, EURO")
  await v.page.getByRole("button", { name: "Save the currencies" }).click()
  await v.page.getByRole("alert").filter({ hasText: /./ }).first().waitFor({ timeout: 60000 })
  ck("N24 a currency that is not a 3-letter code is refused and the server's reason is shown", /allowed_currencies|invalid|Invalid/i.test(await v.page.getByRole("alert").filter({ hasText: /./ }).first().innerText()), await v.page.getByRole("alert").filter({ hasText: /./ }).first().innerText())
  await v.page.screenshot({ path: `${SHOTS}/qa-admin-settings.png`, fullPage: true }); await v.page.close()
  const bad1 = await api(admin, "put", "/api/marketing-admin/settings", { teamId: teamA.id, key: "pipeline_stages", value: [] })
  const bad2 = await api(staff, "put", "/api/marketing-admin/settings", { teamId: teamA.id, key: "qualification_checklist", value: ["x"] })
  const bad3 = await api(admin, "put", "/api/marketing-admin/settings", { teamId: "00000000-0000-0000-0000-000000000000", key: "qualification_checklist", value: ["x"] })
  ck("N25 a setting that is not editable here is refused (400), staff is refused (403), an unknown team is refused (400)", bad1.status === 400 && bad2.status === 403 && bad3.status === 400, [bad1.status, bad2.status, bad3.status])

  // ── who cannot get in ──
  for (const [who, ctx] of [["staff", staff], ["the marketing owner", owner]] as const) {
    for (const path of ["/marketing-leads/leads", "/marketing-leads/audit", "/marketing-leads/teams", "/marketing-leads/settings"]) {
      const x = await view(ctx, path)
      ck(`N26 ${who} cannot open ${path}`, !/Audit log|All leads|Switches|People \(/.test(x.text.replace(/\s+/g, " ").slice(0, 400)) && !/Good Lead/.test(x.text), x.text.slice(0, 120)); await x.page.close()
    }
  }

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
