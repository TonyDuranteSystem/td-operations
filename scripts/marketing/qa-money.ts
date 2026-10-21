/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Money): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up (with migration 20261019-2300 applied) and `td-marketing-qa-leads` running on :3011.
   Run: npx tsx scripts/marketing/qa-mn.ts */
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
const em = (k: string) => `qa-mn-${k.toLowerCase()}@example.test`
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
  await db.query("delete from marketing_sales where lead_id in (select id from marketing_leads where leadgen_id like 'qm-%')")
  await db.query("delete from marketing_lead_events where lead_id in (select id from marketing_leads where leadgen_id like 'qm-%')")
  await db.query("delete from marketing_leads where leadgen_id like 'qm-%'")
  const oldTeams = (await db.query("select id from marketing_teams where name like 'QA mn %'")).rows.map(x => x.id)
  if (oldTeams.length) {
    for (const t of ["marketing_team_members", "marketing_invites", "marketing_settings", "marketing_settings_history", "marketing_commission_terms"]) await db.query(`delete from ${t} where team_id = any($1)`, [oldTeams])
    await db.query("delete from marketing_teams where id = any($1)", [oldTeams])
  }
  await db.query("set session_replication_role = origin")
  for (const u of (await A.listUsers({ perPage: 1000 })).data.users.filter(u => (u.email ?? "").startsWith("qa-mn-"))) await A.deleteUser(u.id)

  const teamA = (await S.createTeam({ name: `QA mn A ${stamp}`, actor: "qa-mn" })).data!
  await S.setTeamStatus(teamA.id, "active", "qa-mn")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-mn", permissions: [] as string[] }
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

  const kindsTerm = await S.addCommissionTerm({ teamId: teamA.id, kind: "strategic_call", sellerPct: 80, actor: "qa-mn" })
  if (kindsTerm.ok === false) throw new Error(`term: ${kindsTerm.error}`)
  const L1 = (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, received_at, answers) values ($1,'qm-1','Mario Rossi','mario.qa@example.test','+393330000001','qualified',now(),'[]'::jsonb) returning id", [teamA.id])).rows[0].id as string

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



  const owner = await session(em("ownerA")), setter = await session(em("setterA")), admin = await session(em("admin")), staff = await session(em("staff"))
  const text = (page: import("playwright").Page, label: string) => page.locator(`section[aria-label="${label}"]`).innerText().then(t => t.replace(/\s+/g, " "))
  const box = (page: import("playwright").Page) => page.locator('section[aria-label="Payment link"]')

  // ── the box: who sees it ──
  let v = await view(owner, `/marketing/leads?lead=${L1}`)
  ck("M1 the owner sees the Payment link box on a lead", await box(v.page).count() === 1, v.text.slice(0, 200))
  const s = await view(setter, `/marketing/leads?lead=${L1}`)
  ck("M2 a setter does NOT see it", await box(s.page).count() === 0)
  await s.page.close()
  const noperm = await setter.request.post(`${BASE}/api/marketing/leads/${L1}/payment-link`, { data: { kind: "strategic_call", amount: "10", currency: "EUR" } })
  ck("M3 a setter calling the link route directly is refused", noperm.status() === 403, noperm.status())

  // ── create a strategic call link: split preview, then a real (test-mode) Stripe link ──
  const b = box(v.page)
  await b.getByLabel("What is it for?").selectOption("strategic_call")
  await b.getByLabel("Amount").fill("1000")
  await b.getByLabel("Currency").selectOption("EUR")
  const prev = (await b.getByTestId("split-preview").innerText()).replace(/\s+/g, " ")
  ck("M4 the split preview shows the share before the link exists", /80%/.test(prev) && /800\.00/.test(prev) && /20%/.test(prev) && /200\.00/.test(prev), prev)
  await v.page.screenshot({ path: `${SHOTS}/qa-mn-box.png`, fullPage: true })
  await b.getByRole("button", { name: "Create payment link" }).click()
  await b.getByTestId("new-link").waitFor({ timeout: 60000 })
  const url1 = await b.getByTestId("new-link").locator("input").inputValue()
  const sale1 = (await db.query("select * from marketing_sales where lead_id=$1 and kind='strategic_call'", [L1])).rows[0]
  ck("M5 a Stripe Checkout link is shown (test mode) and the sale is saved with the split copied from the terms", /^https:\/\/checkout\.stripe\.com\//.test(url1) && sale1?.status === "link_created" && sale1.seller_cents === 80000 && sale1.td_cents === 20000 && /^cs_test_/.test(sale1.stripe_session_id ?? ""), { url1: url1.slice(0, 40), sale1 })
  const ev1 = (await db.query("select kind from marketing_lead_events where lead_id=$1 order by id", [L1])).rows.map(r => r.kind)
  ck("M6 the link is written in the lead's history", ev1.includes("payment_link_created"), ev1)
  await v.page.reload({ waitUntil: "networkidle" })
  ck("M7 'Links for this lead' lists it as 'Link sent'", /Link sent/.test(await box(v.page).innerText()))

  // ── upsell with no terms: honest 'terms not set' ──
  await box(v.page).getByLabel("What is it for?").selectOption("upsell")
  await box(v.page).getByLabel("Amount").fill("500")
  await box(v.page).getByLabel("Currency").selectOption("USD")
  const prevU = (await box(v.page).getByTestId("split-preview").innerText()).replace(/\s+/g, " ")
  ck("M8 an upsell with no terms says 'Terms not set' in the preview", /Terms not set/.test(prevU), prevU)
  await box(v.page).getByRole("button", { name: "Create payment link" }).click()
  await box(v.page).getByTestId("new-link").waitFor({ timeout: 60000 })
  const sale2 = (await db.query("select * from marketing_sales where lead_id=$1 and kind='upsell'", [L1])).rows[0]
  ck("M9 the upsell sale is saved with no split (terms not set)", sale2?.seller_cents === null && sale2?.td_cents === null && sale2?.amount_cents === 50000 && sale2?.currency === "USD", sale2)

  // ── guards on the form ──
  await box(v.page).getByLabel("Amount").fill("abc")
  ck("M10 a bad amount keeps the button disabled", await box(v.page).getByRole("button", { name: "Create payment link" }).isDisabled())
  const setConfirm = await S.setMarketingSetting({ key: "confirm_above_amount", value: 2000, teamId: teamA.id, actor: "qa-mn" })
  if (setConfirm.ok === false) throw new Error(`setting: ${setConfirm.error}`)
  await v.page.reload({ waitUntil: "networkidle" })
  await box(v.page).getByLabel("What is it for?").selectOption("strategic_call")
  await box(v.page).getByLabel("Amount").fill("5000")
  ck("M11 above the 'are you sure' amount the button waits for a tick", await box(v.page).getByRole("button", { name: "Create payment link" }).isDisabled())
  await box(v.page).getByRole("checkbox").check()
  ck("M12 …and works once it is ticked", await box(v.page).getByRole("button", { name: "Create payment link" }).isEnabled())
  const direct = await owner.request.post(`${BASE}/api/marketing/leads/${L1}/payment-link`, { data: { kind: "strategic_call", amount: "5000", currency: "EUR" } })
  ck("M13 the route itself also asks for the confirmation (a script cannot skip it)", direct.status() === 400 && (await db.query("select count(*)::int n from marketing_sales where lead_id=$1", [L1])).rows[0].n === 2, direct.status())
  await db.query("set session_replication_role = replica"); await db.query("delete from marketing_settings where key='confirm_above_amount' and team_id=$1", [teamA.id]); await db.query("set session_replication_role = origin")
  await v.page.close()

  // ── Stripe says it was paid: the REAL webhook handler, signed with the local secret ──
  const { createHmac } = await import("node:crypto")
  const { NextRequest } = await import("next/server")
  const { POST: webhook } = await import("@/app/api/webhooks/stripe/route")
  const send = async (event: object, goodSig = true) => {
    const body = JSON.stringify(event)
    const t = Math.floor(Date.now() / 1000)
    const sig = createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET!).update(`${t}.${body}`).digest("hex")
    return webhook(new NextRequest("http://127.0.0.1/api/webhooks/stripe", { method: "POST", body, headers: { "stripe-signature": `t=${t},v1=${goodSig ? sig : "0".repeat(64)}` } }))
  }
  const meta = (sale: { id: string }, lead: string) => ({ payment_kind: "marketing_sale", marketing_sale_id: sale.id, marketing_lead_id: lead, marketing_team_id: teamA.id, source: "td-marketing" })
  const paid = (sale: { id: string; stripe_session_id: string; amount_cents: number; currency: string }, pi: string, lead: string) => ({
    id: `evt_${pi}`, type: "checkout.session.completed",
    data: { object: { id: sale.stripe_session_id, mode: "payment", payment_intent: pi, amount_total: sale.amount_cents, currency: sale.currency.toLowerCase(), payment_status: "paid", customer_details: { email: "mario.qa@example.test", name: "Mario Rossi" }, metadata: meta(sale, lead) } },
  })
  ck("M14 an event with a wrong signature is refused", (await send(paid(sale1, "pi_qa1", L1), false)).status === 401)
  const r1 = await send(paid(sale1, "pi_qa1", L1))
  const afterPay = (await db.query("select status, stripe_payment_intent, paid_amount_cents, needs_attention from marketing_sales where id=$1", [sale1.id])).rows[0]
  ck("M15 a signed 'paid' event marks the sale paid", r1.status === 200 && afterPay.status === "paid" && afterPay.stripe_payment_intent === "pi_qa1" && afterPay.paid_amount_cents === 100000 && afterPay.needs_attention === null, afterPay)
  const leadNow = (await db.query("select status from marketing_leads where id=$1", [L1])).rows[0].status
  ck("M16 the lead moved to 'Paid call' by itself", leadNow === "paid_call", leadNow)
  const r1b = await send(paid(sale1, "pi_qa1", L1))
  const evCount = (await db.query("select count(*)::int n from marketing_lead_events where lead_id=$1 and kind='payment_received'", [L1])).rows[0].n
  ck("M17 Stripe sending the same event again changes nothing (no double count)", r1b.status === 200 && evCount === 1, { status: r1b.status, evCount })
  const touched = (await db.query("select (select count(*)::int from payments where stripe_payment_id='pi_qa1') p, (select count(*)::int from webhook_events where external_id=$1) w", [sale1.stripe_session_id])).rows[0]
  ck("M18 no client payment row is created, only the raw event is logged once", touched.p === 0 && touched.w === 1, touched)

  // ── the owner's Money page ──
  v = await view(owner, "/marketing/money")
  let eur = await text(v.page, "Totals in EUR")
  ck("M19 Rocco's Money page: sold €1,000, his share €800, nothing paid out yet, €800 still to come", /Sold \(paid\) €1,000\.00/.test(eur) && /Your share €800\.00/.test(eur) && /Paid to your company €0\.00/.test(eur) && /Still to come €800\.00/.test(eur), eur)
  const usd = await text(v.page, "Totals in USD")
  ck("M20 USD is its own card (never added to euros) and shows the open upsell link", /1 link sent/.test(usd) && /Sold \(paid\) \$0\.00/.test(usd), usd)
  const rowsTxt = await text(v.page, "Sales")
  ck("M21 the sales table lists both, the paid one with his share and the upsell as 'Link sent'", /Mario Rossi.*Strategic call.*€1,000\.00.*€800\.00.*Paid/.test(rowsTxt) && /Upsell.*\$500\.00.*Link sent/.test(rowsTxt), rowsTxt)
  await v.page.screenshot({ path: `${SHOTS}/qa-mn-rocco-money.png`, fullPage: true }); await v.page.close()
  v = await view(setter, "/marketing/money")
  ck("M22 a setter cannot open Money", /do not have access to Money/.test(v.text) && !/Sold \(paid\)/.test(v.text), v.text.slice(0, 160)); await v.page.close()

  // ── Antonio: totals, Mark as paid ──
  v = await view(admin, `/marketing-leads/money?team=${teamA.id}`)
  eur = await text(v.page, "Totals in EUR")
  ck("M23 Antonio's Money page: received €1,000, TD €200, owed to the seller's company €800", /Received €1,000\.00/.test(eur) && /TD share €200\.00/.test(eur) && /Owed to the seller's company €800\.00/.test(eur) && /Already paid out €0\.00/.test(eur), eur)
  const termsTxt = await text(v.page, "Terms")
  ck("M24 the split in force: Strategic call 80/20; Upsell 'Terms not set'", /Strategic call 80% 20%/.test(termsTxt) && /Upsell Terms not set/.test(termsTxt), termsTxt)
  await v.page.screenshot({ path: `${SHOTS}/qa-mn-antonio-money.png`, fullPage: true })
  await v.page.locator('section[aria-label="Sales"] tr', { hasText: "Strategic call" }).getByRole("button", { name: "Mark as paid" }).click()
  await v.page.getByLabel("Bank reference").fill("WIRE-QA-1")
  await v.page.getByRole("button", { name: "Save", exact: true }).click()
  await v.page.waitForFunction(() => /Paid · paid out/.test(document.body.innerText), null, { timeout: 60000 })
  const po = (await db.query("select paid_out_at, paid_out_reference, paid_out_by from marketing_sales where id=$1", [sale1.id])).rows[0]
  ck("M25 'Mark as paid' (date + reference) saves who and when", po.paid_out_at && po.paid_out_reference === "WIRE-QA-1" && /admin@example\.test/.test(po.paid_out_by ?? ""), po)
  eur = await text(v.page, "Totals in EUR")
  ck("M26 the totals move the share from 'owed' to 'paid out'", /Owed to the seller's company €0\.00/.test(eur) && /Already paid out €800\.00/.test(eur), eur)
  const stranger = await staff.request.post(`${BASE}/api/marketing-admin/sales/${sale1.id}`, { data: { action: "mark_paid_out", reference: "X", paidOn: "2026-10-22" } })
  ck("M27 a non-admin cannot use the sale routes", stranger.status() === 403, stranger.status())
  const again = await admin.request.post(`${BASE}/api/marketing-admin/sales/${sale1.id}`, { data: { action: "mark_paid_out", reference: "WIRE-QA-2", paidOn: "2026-10-22" } })
  ck("M28 paying out the same sale twice is refused", again.status() === 409, again.status())
  v.page.close()

  // ── terms not set → set the split → apply ──
  await send(paid(sale2, "pi_qa2", L1))
  const upLead = (await db.query("select status from marketing_leads where id=$1", [L1])).rows[0].status
  ck("M29 the paid upsell moves the lead to 'Upsell won'", upLead === "upsell_won", upLead)
  v = await view(admin, `/marketing-leads/money?team=${teamA.id}`)
  const flagRow = await v.page.locator('section[aria-label="Sales"] tr', { hasText: "Upsell" }).innerText()
  ck("M30 the upsell shows 'Terms not set' with an Apply button", /Terms not set/.test(flagRow) && /Apply today's split/.test(flagRow), flagRow)
  await v.page.getByLabel("Kind of sale").selectOption("upsell")
  await v.page.getByLabel("Seller's share %").fill("70")
  await v.page.getByRole("button", { name: "Set the split" }).click()
  await v.page.waitForFunction(() => /Upsell\s+70%\s+30%/.test(document.body.innerText), null, { timeout: 60000 })
  const stillUnset = (await db.query("select seller_cents from marketing_sales where id=$1", [sale2.id])).rows[0].seller_cents
  ck("M31 setting the split does NOT change the old sale by itself", stillUnset === null, stillUnset)
  await v.page.locator('section[aria-label="Sales"] tr', { hasText: "Upsell" }).getByRole("button", { name: "Apply today's split" }).click()
  await v.page.waitForFunction(() => !/Apply today's split/.test(document.body.innerText), null, { timeout: 60000 })
  const ap = (await db.query("select seller_cents, td_cents, seller_pct from marketing_sales where id=$1", [sale2.id])).rows[0]
  ck("M32 'Apply today's split' gives it 70/30 of $500 = $350 / $150", ap.seller_cents === 35000 && ap.td_cents === 15000 && Number(ap.seller_pct) === 70, ap)
  await v.page.close()

  // ── refunds ──
  const refund = (pi: string, amount: number, refunded: number) => ({ id: `evt_r_${pi}_${refunded}`, type: "charge.refunded", data: { object: { id: `ch_${pi}`, payment_intent: pi, amount, amount_refunded: refunded } } })
  await send(refund("pi_qa2", 50000, 10000))
  const r2 = (await db.query("select status, refunded_cents, needs_attention, seller_cents from marketing_sales where id=$1", [sale2.id])).rows[0]
  ck("M33 a partial refund is flagged for Antonio and the split is left alone", r2.status === "partly_refunded" && r2.refunded_cents === 10000 && /Partly refunded/.test(r2.needs_attention) && r2.seller_cents === 35000, r2)
  await send(refund("pi_qa1", 100000, 100000))
  const r1row = (await db.query("select status, needs_attention from marketing_sales where id=$1", [sale1.id])).rows[0]
  ck("M34 a full refund after payout marks it refunded and warns that nothing is taken back", r1row.status === "refunded" && /already paid out/.test(r1row.needs_attention), r1row)
  v = await view(admin, `/marketing-leads/money?team=${teamA.id}`)
  const att = await text(v.page, "Needs your attention")
  eur = await text(v.page, "Totals in EUR")
  ck("M35 'Needs your attention' lists both; the refunded sale leaves the euro totals", /Mario Rossi/.test(att) && /Partly refunded/.test(att) && /already paid out/.test(att) && /Received €0\.00/.test(eur) && /1 refunded sale/.test(eur), { att, eur })
  await v.page.screenshot({ path: `${SHOTS}/qa-mn-antonio-flags.png`, fullPage: true }); await v.page.close()
  const unknown = await send(refund("pi_not_ours", 1000, 1000))
  ck("M36 a refund of some other payment is ignored by the marketing ledger", unknown.status === 200)

  // ── the rest ──
  v = await view(staff, "/marketing-leads/money")
  ck("M37 a staff login cannot open Antonio's Money page", !/Owed to the seller's company/.test(v.text), v.text.slice(0, 100)); await v.page.close()
  v = await view(owner, "/marketing")
  const nav = await v.page.locator('nav[aria-label="Workspace"]').innerText()
  ck("M38 Money is a real menu item for the owner (not greyed 'soon') and the CRM sub-menu has Money", /Money/.test(nav) && !/Money\s+soon/i.test(nav.replace(/\n/g, " ")), nav); await v.page.close()
  v = await view(admin, "/marketing-leads")
  ck("M39 Antonio's CRM sub-menu: Money is a link", (await v.page.getByRole("link", { name: "Money" }).count()) >= 1); await v.page.close()

  await browser.close(); await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
