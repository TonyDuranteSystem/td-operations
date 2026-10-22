/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, build step 4: Leads strip and filters): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-stcess.ts */
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
const em = (k: string) => `qa-st-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qst-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qst-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qst-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA st %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-st-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA st A ${stamp}`, actor: "qa-st" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-st")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-st", permissions: [] as string[] }
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







  const mkLead = async (n: string, name: string, status: string, hoursOld: number, ad: string | null, claimed: string | null = null) =>
    (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, ad_name, received_at, claimed_by, claimed_by_label, answers) values ($1,$2,$3,$4,'+393339990000',$5,$6, now() - ($7 || ' hours')::interval,$8,$9,'[]'::jsonb) returning id", [teamA.id, `qst-${n}`, name, `qst${n}@example.test`, status, ad, String(hoursOld), claimed, claimed ? em("ownerA") : null])).rows[0].id as string
  const evt = (lead: string, actor: string, kind: string, data: object) => db.query("insert into marketing_lead_events (lead_id, kind, actor, data, created_at) values ($1,$2,$3,$4, now() - interval '20 minutes')", [lead, kind, actor, JSON.stringify(data)])
  const stale = await mkLead("a", "Stale Alpha", "new", 80, "Ad Alpha")
  await mkLead("b", "Fresh Beta", "new", 2, "Ad Beta")
  await mkLead("c", "Fresh NoAd", "new", 1, null)
  await mkLead("d", "Picked Alpha", "contacted", 5, "Ad Alpha", ids.ownerA)
  const good = await mkLead("e", "Good Beta", "qualified", 6, "Ad Beta")
  await evt(good, em("setterA"), "status_changed", { from: "new", to: "qualified", outcome: "good", note: "wants an LLC in Wyoming this month" })
  // three old qualified leads far beyond the newest 500, and 520 newer ones in another stage
  for (const n of ["q1", "q2", "q3"]) await mkLead(n, `Old Qualified ${n}`, "qualified", 24 * 300, "Ad Gamma")
  await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, status, ad_name, received_at, answers) select $1, 'qst-fill-' || g, 'Filler ' || g, 'contacted', 'Ad Gamma', now() - ((g % 40 + 7) || ' minutes')::interval, '[]'::jsonb from generate_series(1, 520) g", [teamA.id])
  await evt(stale, em("setterA"), "note", { text: "left a voicemail" })
  await mkLead("zz", "Orphan Stage Lead", "legacy_stage", 9, "Ad Gamma") // a stage that is not in the settings (renamed): no chip, but still a lead
  for (const [k, v] of [["pipeline_stages", [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }, { key: "sold", label: "Sold" }]], ["sale_kind_stages", { strategic_call: "sold" }]] as const) {
    const r = await S.setMarketingSetting({ key: k, value: v, teamId: teamA.id, actor: "qa-st" }); if (r.ok === false) throw new Error(`setting ${k}: ${r.error}`)
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








  const body = (page: import("playwright").Page) => page.locator("body").innerText().then(t => t.replace(/\s+/g, " "))
  const owner = await session(em("ownerA")), ale = await session(em("aleA"))
  const stageCount = async (page: import("playwright").Page, key: string) => Number((await page.locator(`[data-stage="${key}"] b`).innerText()).trim())

  let v = await view(owner, "/marketing/leads")
  const strip = (await v.page.getByTestId("stage-strip").innerText()).replace(/\s+/g, " ")
  ck("S1 the strip counts every stage from the database, not from the 500 shown: New 3, Contacted 521, Qualified 4", (await stageCount(v.page, "new")) === 3 && (await stageCount(v.page, "contacted")) === 521 && (await stageCount(v.page, "qualified")) === 4 && /Any stage 529/.test(strip), strip)
  ck("S2 the plain list says it shows the newest 500", (await v.page.getByTestId("list-cut").count()) === 1)
  await v.page.close()

  v = await view(owner, "/marketing/leads?stage=qualified")
  const q = await body(v.page)
  ck("S3 a stage filter finds the old qualified leads even though they are far beyond the newest 500 (4 leads, no cut notice)", /Old Qualified q1/.test(q) && /Good Beta/.test(q) && (await v.page.getByTestId("list-count").innerText()).startsWith("4 ") && (await v.page.getByTestId("list-cut").count()) === 0, q.slice(0, 400))
  await v.page.close()

  v = await view(owner, "/marketing/leads?ad=Ad%20Beta")
  const b = await body(v.page)
  ck("S4 the Ad filter narrows the list AND the strip: only Beta leads; New 1, Qualified 1, Contacted 0", /Fresh Beta/.test(b) && /Good Beta/.test(b) && !/Stale Alpha/.test(b) && !/Filler/.test(b) && (await stageCount(v.page, "new")) === 1 && (await stageCount(v.page, "qualified")) === 1 && (await stageCount(v.page, "contacted")) === 0, b.slice(0, 300))
  await v.page.close()

  v = await view(owner, "/marketing/leads?ad=__none__")
  ck("S5 'No ad name' finds the lead that came with no ad", /Fresh NoAd/.test(await body(v.page)) && (await v.page.getByTestId("list-count").innerText()).startsWith("1 "))
  await v.page.close()

  v = await view(owner, "/marketing/leads?ad=Nonsense&stage=new")
  ck("S6 an ad that does not exist is ignored (no filter), and the stage still applies", /Stale Alpha/.test(await body(v.page)) && (await v.page.getByTestId("list-count").innerText()).startsWith("3 "))
  await v.page.close()

  v = await view(owner, "/marketing/leads?stage=new")
  const rows = await v.page.locator('[aria-label="Lead list"] li').allInnerTexts()
  const stRow = rows.find(r => /Stale Alpha/.test(r)) ?? "", frRow = rows.find(r => /Fresh Beta/.test(r)) ?? ""
  ck("S7 a lead nobody touched shows how long it waits: 'waiting 3 d' (red) for the 80 h one, 'waiting 2 h' for the fresh one", /waiting 3 d/.test(stRow) && /waiting 2 h/.test(frRow), [stRow, frRow])
  const redText = await v.page.locator('[data-late="1"]').first().evaluate(el => getComputedStyle(el).color)
  ck("S8 the long wait is red and also says '(late)' in words", /rgb\(185, 28, 28\)/.test(redText) && /waiting 3 d \(late\)/.test(stRow), [redText, stRow])
  ck("S9 a row shows its ad; a lead with no ad name shows nothing there (no repeated 'No ad name')", /Ad Alpha/.test(stRow) && rows.some(r => /Fresh NoAd/.test(r) && !/No ad name/.test(r)))
  ck("S10 the owner sees who gave the setter's note on the stale lead", /left a voicemail/.test(stRow), stRow)
  await v.page.close()

  v = await view(owner, "/marketing/leads?stage=qualified&ad=Ad%20Beta")
  const gr = (await v.page.locator('[aria-label="Lead list"] li').first().innerText()).replace(/\s+/g, " ")
  ck("S11 a marked lead shows 'Good by' the setter's name and a one-line note", /Marked good by Qa St Settera/.test(gr) && /wants an LLC in Wyoming/.test(gr), gr)
  const waitingCount = await v.page.locator('[data-testid="waiting"]').count()
  ck("S12 a lead somebody has worked does not say 'waiting'", waitingCount === 0, waitingCount)
  await v.page.close()

  v = await view(owner, "/marketing/leads?stage=contacted&show=mine")
  ck("S13 'Picked by me' together with a stage: only my lead (the picked Alpha one); the strip follows 'mine'", /Picked Alpha/.test(await body(v.page)) && (await v.page.getByTestId("list-count").innerText()).startsWith("1 ") && (await stageCount(v.page, "contacted")) === 1)
  await v.page.close()

  v = await view(owner, "/marketing/leads")
  const person = v.page.getByTestId("person-filter")
  await person.locator("summary").click()
  ck("S14 the owner has a 'Worked on by' menu with the team's people (and 'Anyone')", (await person.count()) === 1 && /Qa St Settera/.test(await person.innerText()) && /Anyone/.test(await person.innerText()))
  await person.getByRole("link", { name: "Qa St Settera" }).click()
  await v.page.waitForURL(/by=/, { timeout: 60000 }); await v.page.waitForLoadState("networkidle")
  const pb = await body(v.page)
  ck("S15 choosing a person shows only what she worked on (Good Beta, Stale Alpha), with the strip counted from those", /Good Beta/.test(pb) && /Stale Alpha/.test(pb) && !/Fresh Beta/.test(pb) && (await stageCount(v.page, "qualified")) === 1 && (await stageCount(v.page, "new")) === 1, pb.slice(0, 300))
  await v.page.close()

  v = await view(owner, "/marketing/leads")
  const adSel = v.page.getByTestId("ad-filter")
  await adSel.locator("summary").click()
  await adSel.getByRole("link", { name: "Ad Alpha (2)" }).click()
  await v.page.waitForURL(/ad=Ad(\+|%20)Alpha/, { timeout: 60000 }); await v.page.waitForLoadState("networkidle")
  ck("S16 choosing an ad from the drop-down opens the filtered list", /Stale Alpha/.test(await body(v.page)) && !/Fresh Beta/.test(await body(v.page)))
  ck("S16b and the menu closes after the pick (it does not stay over the list)", (await v.page.getByTestId("ad-filter").evaluate(el => (el as HTMLDetailsElement).open)) === false)
  await v.page.getByTestId("person-filter").locator("summary").click(); await v.page.keyboard.press("Escape")
  ck("S16c Escape closes an open menu", (await v.page.getByTestId("person-filter").evaluate(el => (el as HTMLDetailsElement).open)) === false)
  await v.page.screenshot({ path: `${SHOTS}/qa-st-leads.png`, fullPage: true }); await v.page.close()

  // the applied filters are shown and can be cleared; the empty state says why; counts and header are honest; the overdue come first in 'Not picked yet'
  v = await view(owner, "/marketing/leads?stage=new&ad=Ad%20Alpha")
  const ap = (await v.page.getByTestId("applied").innerText()).replace(/\s+/g, " ")
  ck("S18 a line says what is applied ('Stage: New', 'Ad: Ad Alpha') with a Clear all link", /Stage: New/.test(ap) && /Ad: Ad Alpha/.test(ap) && (await v.page.getByTestId("clear-filters").count()) === 1, ap)
  await v.page.close()
  v = await view(owner, "/marketing/leads?stage=not_in_target&ad=Ad%20Beta")
  const em0 = (await v.page.getByTestId("empty").innerText()).replace(/\s+/g, " ")
  ck("S19 no result under a filter says 'No leads match ...' and offers Clear all (never 'No leads yet')", /No leads match/.test(em0) && !/No leads yet/.test(em0) && /Clear all filters/.test(em0), em0)
  ck("S20 a stage with no leads is dimmed in the strip", (await v.page.locator('[data-stage="sold"]').getAttribute("class"))!.includes("text-slate-400"))
  await v.page.close()
  v = await view(owner, "/marketing/leads")
  ck("S21 over the cap the header is honest: 'Showing 500 of 529'", /Showing 500 of 529/.test(await v.page.getByTestId("list-count").innerText()), await v.page.getByTestId("list-count").innerText())
  await v.page.close()
  v = await view(owner, "/marketing/leads?show=free&stage=new")
  const first = (await v.page.locator('[aria-label="Lead list"] li').first().innerText()).replace(/\s+/g, " ")
  ck("S22 'Not picked yet' lists the lead waiting longest first (Stale Alpha, 3 d, before the fresh ones)", /Stale Alpha/.test(first), first)
  await v.page.close()
  v = await view(owner, "/marketing/leads?stage=new")
  const adm = v.page.getByTestId("ad-filter"); await adm.locator("summary").click()
  const adTxt = (await adm.innerText()).replace(/\s+/g, " ")
  ck("S23 the ad counts follow the stage: with 'New' chosen Ad Alpha has 1, Ad Gamma 0", /Ad Alpha \(1\)/.test(adTxt) && /Ad Gamma \(0\)/.test(adTxt), adTxt)
  await v.page.close()

  v = await view(ale, "/marketing/leads?stage=new")
  const ar = await body(v.page)
  const aleHtml = await v.page.content()
  ck("S17 the ad person gets the strip and the Ad filter but NO Person filter, and no setter name, mark or note in the rows (not even in the page the server sent)", (await v.page.getByTestId("ad-filter").count()) === 1 && (await v.page.getByTestId("person-filter").count()) === 0 && /Stale Alpha/.test(ar) && !/left a voicemail/.test(aleHtml) && !/Qa St Settera/.test(aleHtml), ar.slice(0, 300))
  await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
