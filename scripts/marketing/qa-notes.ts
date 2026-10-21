/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Money): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-sn.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3011"
const PASS = "Qa-ws-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const stamp = Date.now()
const em = (k: string) => `qa-sn-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qs-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qs-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qs-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA sn %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-sn-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA sn A ${stamp}`, actor: "qa-sn" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-sn")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-sn", permissions: [] as string[] }
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
  await mk("ownerA", "owner"); await mk("setterA", "member", "setter"); await mk("aleA", "member", "content")
  for (const [key, role] of [["admin", "admin"], ["staff", "team"]] as const) {
    const r = await (supabaseAdmin as unknown as { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }).auth.admin.createUser({ email: em(key), password: PASS, email_confirm: true, app_metadata: { role } })
    if (r.error || !r.data.user) throw new Error(`seed ${key}: ${r.error?.message}`)
    ids[key] = r.data.user.id
  }




  const teamB = (await S.createTeam({ name: `QA sn B ${stamp}`, actor: "qa-sn" })).data!
  const mkLead = async (team: string, n: string, name: string, status: string, claimed: string | null = null, qualification: object | null = null) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, claimed_at, qualification, answers) values ($1,$2,$3,$4,'+393330000000',$5,'Ad Alpha', now() - interval '3 hours',$6,$7, case when $6::uuid is null then null else now() end, $8::jsonb,'[]'::jsonb) returning id", [team, `qs-${n}`, name, `qs${n}@example.test`, status, claimed, claimed ? em("ownerA") : null, qualification ? JSON.stringify(qualification) : null])).rows[0].id as string
  const evt = (lead: string, actor: string, kind: string, data: object, hoursAgo = 0.5) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,$2,$3,$4, now() - ($5 || ' hours')::interval)", [lead, kind, actor, JSON.stringify(data), String(hoursAgo)])
  const NOTE = "Wants an LLC for his e-commerce, lives in Milan, can talk Thursday"
  const l1 = await mkLead(teamA.id, "1", "Good With Note", "qualified", null, [{ item: "Has a business", ticked: true }, { item: "Wants a US company", ticked: false }])
  await evt(l1, em("setterA"), "status_changed", { from: "new", to: "qualified", outcome: "good", note: NOTE, qualification: [{ item: "Has a business", ticked: true }, { item: "Wants a US company", ticked: false }] })
  await evt(l1, em("ownerA"), "note", { text: "Rocco: call him after 6pm" }, 0.2)
  const l2 = await mkLead(teamA.id, "2", "Rejected One", "not_in_target")
  await evt(l2, em("setterA"), "status_changed", { from: "new", to: "not_in_target", outcome: "not_in_target", reason: "wrong_profile", note: "employee, no company" })
  await mkLead(teamA.id, "3", "Done Sold", "sold", ids.ownerA)
  const l5 = await mkLead(teamA.id, "5", "Busy Lead", "contacted")
  await db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) select $1, 'note', $2, jsonb_build_object('text', 'old note ' || g), now() - ((300 - g) || ' minutes')::interval from generate_series(1, 205) g", [l5, em("setterA")])
  const lB = await mkLead(teamB.id, "9", "Other Team Lead", "qualified")
  await evt(lB, em("setterA"), "status_changed", { from: "new", to: "qualified", outcome: "good", note: "OTHER TEAM SECRET" })
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }, { key: "sold", label: "Sold" }]], ["sale_kind_stages", { strategic_call: "sold" }]] as const) {
    const r = await S.setMarketingSetting({ key: k, value: v, teamId: teamA.id, actor: "qa-sn" }); if (r.ok === false) throw new Error(`setting ${k}: ${r.error}`)
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






  const owner = await session(em("ownerA")), setter = await session(em("setterA")), ale = await session(em("aleA")), admin = await session(em("admin"))
  const body = (page: import("playwright").Page) => page.locator("body").innerText().then(t => t.replace(/\s+/g, " "))

  // ── the note at the top of the lead ──
  let v = await view(owner, `/marketing/leads?lead=${l1}`)
  const nb = v.page.getByTestId("setter-note")
  const nt = (await nb.innerText()).replace(/\s+/g, " ")
  ck("S1 the owner sees the Setter's note: outcome Good, who (a name, not an email), the note, the ticks", /Setter's note/.test(nt) && /Good/.test(nt) && /Qa Sn Settera/.test(nt) && nt.includes(NOTE) && /✔ Confirmed: Has a business/.test(nt) && /✘ Not confirmed: Wants a US company/.test(nt), nt)
  ck("S2 Rocco's own note on the lead is in the same block, labelled by author", /Qa Sn Ownera/.test(nt) && /call him after 6pm/.test(nt), nt)
  const order = await v.page.evaluate(() => { const n = document.querySelector('[data-testid="setter-note"]'); const a = Array.from(document.querySelectorAll('section')).find(x => /What to do with this lead/.test(x.textContent ?? '')) ?? null; return !!n && !!a && !!(n.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) })
  ck("S3 the note comes BEFORE the action buttons", order)
  await v.page.screenshot({ path: `${SHOTS}/qa-sn-owner-lead.png`, fullPage: true }); await v.page.close()

  v = await view(owner, `/marketing/leads?lead=${l2}`)
  const rj = (await v.page.getByTestId("setter-note").innerText()).replace(/\s+/g, " ")
  ck("S4 a rejected lead shows Not in target with the reason and her note", /Not in target: Wrong profile/.test(rj) && /employee, no company/.test(rj), rj); await v.page.close()

  v = await view(setter, `/marketing/leads?lead=${l1}`)
  ck("S5 the setter sees the same block, including Rocco's note", (await v.page.getByTestId("setter-note").count()) === 1 && /call him after 6pm/.test(await v.page.getByTestId("setter-note").innerText())); await v.page.close()

  // ── the ad person: server-side, not just hidden ──
  v = await view(ale, `/marketing/leads?lead=${l1}`)
  const html = await v.page.content()
  const aleText = await body(v.page)
  ck("S6 the ad person sees the lead but NO Setter's note block", /Good With Note/.test(aleText) && (await v.page.getByTestId("setter-note").count()) === 0, aleText.slice(0, 300))
  ck("S7 and the note text is not anywhere in what the server sent her (not even hidden)", !html.includes("e-commerce") && !html.includes("call him after 6pm") && !html.includes("Wants a US company") && !html.includes("employee, no company"), "leak")
  await v.page.close()

  // ── Today: the note on the Good lead's row ──
  v = await view(owner, "/marketing/today")
  const gn = (await v.page.getByTestId("good-note").first().innerText()).replace(/\s+/g, " ")
  ck("S8 on Today each Good lead waiting shows the setter's note, with her name", /Qa Sn Ownera|Qa Sn Settera/.test(gn) && /(call him after 6pm|e-commerce)/.test(gn), gn)
  const mine = (await v.page.locator('section[aria-label="My leads"]').innerText()).replace(/\s+/g, " ")
  ck("S9 'Your leads' leaves out the lead at the stage a paid sale moves to (the stage is renamed 'sold' in the settings, not the built-in name)", !/Done Sold/.test(mine), mine)
  await v.page.screenshot({ path: `${SHOTS}/qa-sn-today.png`, fullPage: true }); await v.page.close()

  // ── numbers are the team's own ──
  v = await view(setter, "/marketing/my-numbers?period=all")
  ck("S10 another team's work by the same person is not in her numbers (2 marked here: one Good, one Not in target)", (await v.page.getByTestId("worked").innerText()) === "2" && (await v.page.getByTestId("good").innerText()) === "1", [await v.page.getByTestId("worked").innerText(), await v.page.getByTestId("good").innerText()]); await v.page.close()

  // ── the history keeps the NEWEST events ──
  v = await view(owner, `/marketing/leads?lead=${l5}`)
  const hist = await body(v.page)
  ck("S11 a lead with 205 history rows shows the newest ones (not the oldest 200)", hist.includes("old note 205") && !/Note: old note 1 ·/.test(hist), hist.slice(-200)); await v.page.close()

  // ── View as: tagged, not counted, shown ──
  const set = await admin.request.post(`${BASE}/api/marketing-admin/view-as`, { data: { teamId: teamA.id, as: "owner" } })
  const act = await admin.request.post(`${BASE}/api/marketing/leads/${l5}/action`, { data: { action: "note", note: "Antonio looking in" } })
  const tag = (await db.query("select data from marketing_lead_events where lead_id=$1 and kind='note' and actor=$2", [l5, em("admin")])).rows[0]?.data
  ck("S12 an action by Antonio while viewing as someone is saved with a tag", set.ok() && act.ok() && tag?.via_view_as === true, { set: set.status(), act: act.status(), tag })
  const av = await admin.newPage()
  await av.goto(`${BASE}/marketing/leads?lead=${l5}`, { waitUntil: "networkidle", timeout: 180000 })
  ck("S13 the History says '(viewing as)' on that line", /Antonio looking in[\s\S]*\(viewing as\)/.test(await av.locator("body").innerText()))
  await av.close()
  v = await view(owner, "/marketing/reports?period=all")
  const st = (await v.page.locator('section[aria-label="Setters"]').innerText()).replace(/\s+/g, " ")
  ck("S14 Antonio's tagged action is not in the setters table", !/admin@example\.test|Qa Sn Admin/.test(st), st); await v.page.close()

  // ── more than 1000 rows: the database cuts one answer at 1000, so long lists are read in pages ──
  await db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) select $1, 'status_changed', $2, jsonb_build_object('from','new','to','qualified','outcome','good'), now() - ((g) || ' seconds')::interval from generate_series(1, 1300) g", [l5, em("setterA")])
  v = await view(setter, "/marketing/my-numbers?period=all")
  const worked = await v.page.getByTestId("worked").innerText()
  ck("S15 with 1300 more marks, her all-time numbers count every one (1302), not just the first 1000", worked === "1302" && (await v.page.getByText("older records are not included").count()) === 0, worked); await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
