/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, round 2 step 4: Templates): proves who can read and who can change the message templates, the Templates
   screen, the owner's Save as template in the lead's message box, and that a setter is refused, through the REAL login page, dev server and database.
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa` running on :3010.
   Run: npx tsx scripts/marketing/qa-templates.ts */
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










  const body = (page: import("playwright").Page) => page.locator("body").innerText().then(t => t.replace(/\s+/g, " "))
  type Pg = import("playwright").Page
  const owner = await session(em("ownerA")), setter = await session(em("setterA"))
  const stored = async () => ((await db.query("select value from marketing_settings where key='team_templates' and team_id=$1", [teamA.id])).rows[0]?.value ?? {}) as Record<string, { label?: string; it?: string; en?: string }>
  const row = (p: Pg, key: string) => p.locator(`[data-testid=tpl-row][data-key="${key}"]`)

  // ---- who sees what
  const op = await owner.newPage()
  await op.goto(BASE + "/marketing/templates", { waitUntil: "networkidle", timeout: 180000 })
  ck("T1 the owner sees the 7 built-in templates, the + New button and an Edit button on each", (await op.getByTestId("tpl-row").count()) === 7 && (await op.getByTestId("tpl-new").count()) === 1 && (await op.getByTestId("tpl-edit").count()) === 7)
  const sp = await setter.newPage()
  await sp.goto(BASE + "/marketing/templates", { waitUntil: "networkidle", timeout: 180000 })
  ck("T2 the setter sees the same templates but no New/Edit/Delete/Reset and a line saying only the owner can change them", (await sp.getByTestId("tpl-row").count()) === 7 && (await sp.getByTestId("tpl-new").count()) === 0 && (await sp.getByTestId("tpl-edit").count()) === 0 && (await sp.getByTestId("tpl-readonly").count()) === 1)
  await op.screenshot({ path: `${SHOTS}/qa-tpl-owner.png`, fullPage: true })

  // ---- the owner creates one (needs a name and a text; an unknown placeholder is refused and nothing is saved)
  await op.getByTestId("tpl-new").click()
  await op.getByTestId("tpl-dialog").waitFor({ timeout: 30000 })
  ck("T3 the Save button stays off until there is a name and a text", (await op.getByTestId("tpl-save").isDisabled()) === true)
  await op.getByTestId("tpl-name").fill("Offer reminder")
  await op.getByTestId("tpl-it").fill("Buongiorno {nmae}, un promemoria.")
  await op.getByTestId("tpl-save").click()
  await op.getByTestId("tpl-error").waitFor({ timeout: 30000 })
  ck("T4 a misspelled placeholder is refused with the allowed ones named, and nothing was written", /\{name\}/.test(await op.getByTestId("tpl-error").innerText()) && Object.keys(await stored()).length === 0)
  await op.getByTestId("tpl-it").fill("Buongiorno {name}, un promemoria da {setter}.")
  await op.getByTestId("tpl-en").fill("Hello {name}, a reminder from {setter}.")
  ck("T5 the preview fills the sample lead in", /Buongiorno Marco, un promemoria da Cristina/.test(await op.getByTestId("tpl-preview").innerText()))
  await op.getByTestId("tpl-save").click()
  await op.getByTestId("tpl-dialog").waitFor({ state: "detached", timeout: 30000 })
  await op.waitForTimeout(1500)
  const s1 = await stored(); const k1 = Object.keys(s1)[0]
  ck("T6 the new template is saved for the team with its name and both texts, and listed as 'yours'", Object.keys(s1).length === 1 && s1[k1].label === "Offer reminder" && /\{name\}/.test(s1[k1].it ?? "") && /Hello/.test(s1[k1].en ?? "") && /yours/.test(await row(op, k1).innerText()), s1)

  // ---- edit a built-in, then reset it
  await row(op, "first_contact").getByTestId("tpl-edit").click()
  await op.getByTestId("tpl-it").fill("Ciao {name}, sono {setter}.")
  await op.getByTestId("tpl-save").click()
  await op.getByTestId("tpl-dialog").waitFor({ state: "detached", timeout: 30000 })
  await op.waitForTimeout(1500)
  ck("T7 an edited built-in says 'built-in, edited' and offers Reset; only the Italian changed, the English original stays", /built-in, edited/.test(await row(op, "first_contact").innerText()) && (await row(op, "first_contact").getByTestId("tpl-reset").count()) === 1 && (await stored()).first_contact?.it === "Ciao {name}, sono {setter}." && !(await stored()).first_contact?.en)
  await row(op, "first_contact").getByTestId("tpl-reset").click()
  await op.waitForTimeout(1500)
  ck("T8 Reset to original brings the built-in wording back and removes the entry", !("first_contact" in (await stored())) && (await row(op, "first_contact").getByTestId("tpl-reset").count()) === 0)

  // ---- the setter cannot change anything, even by calling the server directly
  const setterPost = await sp.evaluate(async () => { const r = await fetch("/api/marketing/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", label: "Sneaky", it: "hello" }) }); return { status: r.status, body: await r.json().catch(() => ({})) } })
  ck("T9 the server refuses a setter (403) and nothing is written", setterPost.status === 403 && !Object.values(await stored()).some(v => v.label === "Sneaky"), setterPost)
  const badBody = await op.evaluate(async () => { const r = await fetch("/api/marketing/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", key: "first_contact" }) }); return { status: r.status, body: await r.json().catch(() => ({})) } })
  ck("T10 even the owner cannot delete a built-in template (400 with a clear reason)", badBody.status === 400 && /built-in/.test(badBody.body.error ?? ""), badBody)

  // ---- the lead's message box
  const lp = await owner.newPage()
  await lp.goto(`${BASE}/marketing/window/${L1}?role=setter`, { waitUntil: "networkidle", timeout: 180000 })
  ck("T11 in the lead's message box the picker lists the new template, and the owner has Save as template", (await lp.getByTestId("template-select").locator("option", { hasText: "Offer reminder" }).count()) === 1 && (await lp.getByTestId("save-as-template").count()) === 1)
  await lp.getByTestId("template-select").selectOption({ label: "Offer reminder" })
  ck("T12 picking it fills this lead's first name in", /Hello Marco, a reminder from/.test(await lp.getByTestId("message-text").inputValue()), await lp.getByTestId("message-text").inputValue())
  await lp.getByTestId("message-text").fill("Hello Marco, a brand new wording from Qa Cl Ownera.")
  await lp.getByTestId("save-as-template").click()
  await lp.getByTestId("template-name").fill("Brand new")
  ck("T13 the box shows exactly what will be saved, with the lead's name turned back into {name}", /Hello \{name\}, a brand new wording/.test(await lp.getByTestId("template-as-saved").innerText()), await lp.getByTestId("template-as-saved").innerText())
  await lp.getByTestId("confirm-save-template").click()
  await lp.getByTestId("confirm-save-template").waitFor({ state: "detached", timeout: 30000 })
  const s2 = await stored(); const nk = Object.keys(s2).find(k => s2[k].label === "Brand new")
  ck("T14 saved as a new template in the page's language (English here) with the placeholder, nobody's name in it", !!nk && /^Hello \{name\}, a brand new wording/.test(s2[nk!].en ?? "") && !/Marco/.test(s2[nk!].en ?? ""), s2)
  await lp.getByTestId("template-select").selectOption({ label: "Offer reminder" })
  await lp.getByTestId("message-text").fill("Hello Marco, the updated reminder.")
  await lp.getByTestId("update-template").click()
  await lp.getByTestId("confirm-save-template").click()
  await lp.getByTestId("confirm-save-template").waitFor({ state: "detached", timeout: 30000 })
  ck("T15 'Update' replaces the wording of the template that was picked, only in this language (the Italian stays)", (await stored())[k1].en === "Hello {name}, the updated reminder." && /Buongiorno/.test((await stored())[k1].it ?? ""), (await stored())[k1])

  // ---- the setter uses them but cannot save
  const sl = await setter.newPage()
  await sl.goto(`${BASE}/marketing/window/${L1}?role=setter`, { waitUntil: "networkidle", timeout: 180000 })
  ck("T16 the setter's message box lists the new templates, and has NO Save as template", (await sl.getByTestId("template-select").locator("option", { hasText: "Brand new" }).count()) === 1 && (await sl.getByTestId("save-as-template").count()) === 0)

  // ---- the menu
  await sp.goto(BASE + "/marketing/leads", { waitUntil: "networkidle", timeout: 180000 })
  ck("T17 Templates is in the setter's menu", /\bTemplates\b/.test(await body(sp)))
  const alep = await (await session(em("aleA"))).newPage()
  await alep.goto(BASE + "/marketing/templates", { waitUntil: "networkidle", timeout: 180000 })
  ck("T18 the ads person (no right to mark leads) gets the no-access line and sees no template", /do not have access to the templates/.test(await body(alep)) && (await alep.getByTestId("tpl-row").count()) === 0)

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
