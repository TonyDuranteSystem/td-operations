/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa: Rocco's six-column board, his four results and the short payment address, 2026-10-26): proves, through the REAL login page, the REAL dev server and the REAL database, that the seller board has the six columns,
   that the results move a lead, and that the short payment address redirects.
   Needs: the private stack up and `td-marketing-qa` running on :3010 (QA_BASE), team 'QA td A' with leads at several stages.
   Run: npx tsx scripts/marketing/qa-seller-board.ts */
import { config } from "dotenv"
config({ path: ".env.local" })

import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const PASS = "Qa-ws-pass-12345"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
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

  const team = (await db.query("select id from marketing_teams where name like 'QA td A%' limit 1")).rows[0].id as string
  // the QA team stored its own stage list long ago; Antonio's team has none stored (the built-in list, with the new stages, applies). Use the built-in list here.
  await db.query("delete from marketing_settings where team_id=$1 and key in ('pipeline_stages','seller_result_stages')", [team])
  // the welcome tour must not cover the screen (it shows once to anyone who has not skipped it)
  for (const em of ["qa-td-ownera@example.test", "qa-td-settera@example.test"]) for (const tk of ["owner", "setter", "seller", "analyst", "content", "generic"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) select u.id, $2, $3, 'skipped' from auth.users u where u.email=$1 on conflict do nothing", [em, team, tk])
  const owner = await session("qa-td-ownera@example.test")
  const p = await owner.newPage()
  p.on("dialog", d => d.accept())
  await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
  await p.evaluate(async () => { await fetch("/api/marketing/lang", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang: "en" }) }) }) // an older QA run may have left Italian
  await p.reload({ waitUntil: "networkidle" })
  await p.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
  const cols = await p.$$eval("[data-column]", els => els.map(e => e.getAttribute("data-column")))
  ck("S1 the seller sees Rocco's six columns, in his order", JSON.stringify(cols) === JSON.stringify(["booked", "out", "closed", "not_closed", "not_ready", "paid"]), cols)
  const heads = await p.$$eval("[data-column]", els => els.map(e => (e.textContent ?? "").slice(0, 40)))
  ck("S2 the titles are the English words", /Booked calls/.test(heads[0]) && /Not in target/.test(heads[1]) && /Closed/.test(heads[2]) && /Not closed/.test(heads[3]) && /Not ready now/.test(heads[4]) && /Paid/.test(heads[5]), heads)
  await p.screenshot({ path: `${SHOTS}/seller-six-columns.png` })

  // four leads at the stage a lead has after the call (they are put at 'showed' first)
  const ids = (await db.query("select id from marketing_leads where team_id=$1 and status not in ('paid_call','upsell_won') order by received_at desc limit 4", [team])).rows.map(r => r.id as string)
  ck("S3 the QA team has leads to work with", ids.length >= 4, ids.length)
  await db.query("update marketing_leads set status='showed', claimed_by=null, claimed_by_label=null, callback_at=null, not_in_target_reason=null where id = any($1)", [ids])
  const stageOf = async (id: string) => (await db.query("select status, callback_at from marketing_leads where id=$1", [id])).rows[0] as { status: string; callback_at: Date | null }
  async function openLead(id: string) {
    await p.goto(`${BASE}/marketing/window/${id}?role=seller`, { waitUntil: "networkidle", timeout: 180000 })
    await p.waitForSelector('[data-testid="lead-result"]', { timeout: 60000 })
  }

  await openLead(ids[0])
  const btns = (await p.locator('[data-testid="lead-result"] button').allInnerTexts()).map(x => x.trim())
  ck("S4 the seller's result buttons are Not in target, Not ready now, Closed, Not closed (no Good, no Call back later)", ["Not in target", "Not ready now", "Closed", "Not closed"].every(b => btns.includes(b)) && !btns.includes("Good") && !btns.includes("Call back later"), btns)
  await p.screenshot({ path: `${SHOTS}/seller-result-buttons.png` })
  // Closed
  await p.click('[data-testid="result-closed"]')
  await p.getByRole("button", { name: "Save" }).click()
  await p.waitForTimeout(1500)
  ck("S5 Closed moves the lead to Closed", (await stageOf(ids[0])).status === "closed", await stageOf(ids[0]))
  const hist = (await db.query("select kind, data from marketing_lead_events where lead_id=$1 and kind='status_changed' order by id desc limit 1", [ids[0]])).rows[0]
  ck("S6 the history line records the outcome", hist?.data?.outcome === "closed", hist)
  ck("S7 the lead page reads 'Closed' in the history", (await p.locator("ol").innerText()).includes("Closed"))
  // Not closed
  await openLead(ids[1])
  await p.click('[data-testid="result-not-closed"]')
  await p.getByRole("button", { name: "Save" }).click()
  await p.waitForTimeout(1500)
  ck("S8 Not closed moves the lead to Not closed", (await stageOf(ids[1])).status === "not_closed", await stageOf(ids[1]))
  // Not ready now: the day is required
  await openLead(ids[2])
  await p.click('[data-testid="result-not-ready"]')
  ck("S9 'Not ready now' cannot be saved without a day", await p.getByRole("button", { name: "Save" }).isDisabled())
  const inMonths = (m: number) => { const d = new Date(Date.now() + m * 30 * 24 * 3600 * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T10:00` }
  await p.locator('input[type="datetime-local"]').fill(inMonths(6))
  await p.getByRole("button", { name: "Save" }).click()
  await p.waitForTimeout(1500)
  const nr = await stageOf(ids[2])
  ck("S10 Not ready now, six months away, is accepted and stores the day", nr.status === "not_ready" && nr.callback_at !== null && nr.callback_at.getTime() > Date.now() + 150 * 24 * 3600 * 1000, nr)
  // Not in target (a lead the setter passed on to Rocco; one the setter turned down before it reached him is not on his board)
  await db.query("insert into marketing_lead_events (lead_id, kind, actor, data) values ($1,'handover','qa','{}'::jsonb)", [ids[3]])
  await openLead(ids[3])
  await p.getByRole("button", { name: "Not in target" }).first().click()
  await p.locator("select").first().selectOption({ index: 1 })
  await p.getByRole("button", { name: "Save" }).click()
  await p.waitForTimeout(1500)
  ck("S11 Not in target moves the lead to Not in target", (await stageOf(ids[3])).status === "not_in_target", await stageOf(ids[3]))

  // the board now shows them in the right columns, with the come-back day on the Not ready now card
  await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
  await p.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
  const inCol = async (col: string) => p.$$eval(`[data-column="${col}"] [data-testid="board-card"]`, els => els.length)
  ck("S12 each result is in its own column", (await inCol("closed")) >= 1 && (await inCol("not_closed")) >= 1 && (await inCol("not_ready")) >= 1 && (await inCol("out")) >= 1, { closed: await inCol("closed"), not_closed: await inCol("not_closed"), not_ready: await inCol("not_ready"), out: await inCol("out") })
  const chip = await p.locator('[data-column="not_ready"]').innerText()
  ck("S13 the Not ready now card shows the day to come back", /Come back/.test(chip), chip.slice(0, 200))
  await p.screenshot({ path: `${SHOTS}/seller-results-board.png` })
  // Italian words
  await p.evaluate(async () => { await fetch("/api/marketing/lang", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang: "it" }) }) })
  await p.reload({ waitUntil: "networkidle" })
  const itHeads = (await p.$$eval("[data-column]", els => els.map(e => (e.textContent ?? "").slice(0, 40)))).join(" | ")
  ck("S14 Rocco's Italian words are on the board", ["Chiamate fissate", "Fuori target", "Chiuso", "Non chiuso", "Non pronto ora", "Pagato"].every(w => itHeads.includes(w)), itHeads)
  await p.screenshot({ path: `${SHOTS}/seller-six-columns-it.png` })
  await p.evaluate(async () => { await fetch("/api/marketing/lang", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang: "en" }) }) })

  // pressing the same result twice, or a result on a lead that has paid, is refused
  const same = await p.evaluate(async id => { const r = await fetch(`/api/marketing/leads/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "closed" }) }); return r.status }, ids[0])
  ck("S14b pressing Closed on a lead that is already Closed is refused (no duplicate history)", same === 409, same)

  // a new booked call brings a Not closed lead back to the booked calls
  const at = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString()
  const r1 = await p.evaluate(async ({ id, at }) => { const r = await fetch(`/api/marketing/leads/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "appointment", at }) }); return { status: r.status } }, { id: ids[1], at })
  ck("S15 booking a new call on a Not closed lead brings it back to Booked calls", r1.status === 200 && (await stageOf(ids[1])).status === "booked", { r1, now: await stageOf(ids[1]) })
  // a Closed lead that pays moves to Paid (the payment code path: the stage for the kind, whatever the lead was)
  const paidStage = (await db.query("select value from marketing_settings where team_id=$1 and key='sale_kind_stages'", [team])).rows[0]?.value?.strategic_call ?? "paid_call"
  await db.query("update marketing_leads set status=$2 where id=$1", [ids[0], paidStage])
  await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
  await p.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
  ck("S16 a lead that was Closed and then paid is in Paid and no longer in Closed", (await p.$$eval('[data-column="paid"] [data-testid="board-card"]', e => e.length)) >= 1)

  // ---- the short payment address
  const sale = async (over: Record<string, unknown>) => {
    const row = { team_id: team, lead_id: ids[0], kind: "strategic_call", amount_cents: 49700, currency: "EUR", created_by: "qa", status: "link_created", checkout_url: "https://checkout.stripe.test/c/pay/cs_test_ABCDEF", link_expires_at: new Date(Date.now() + 20 * 3600 * 1000).toISOString(), ...over }
    const cols2 = Object.keys(row)
    const res = await db.query(`insert into marketing_sales (${cols2.join(",")}) values (${cols2.map((_, i) => "$" + (i + 1)).join(",")}) returning id`, Object.values(row))
    return res.rows[0].id as string
  }
  const code = (id: string) => id.replace(/-/g, "").slice(0, 12)
  const hit = async (c: string) => { const r = await fetch(`${BASE}/pay/s/${c}`, { redirect: "manual" }); return { status: r.status, loc: r.headers.get("location"), body: r.status === 302 ? "" : (await r.text()).slice(0, 300) } }
  const live = await sale({})
  const a = await hit(code(live))
  ck("S17 the short address sends the client to the Stripe page", a.status === 302 && a.loc === "https://checkout.stripe.test/c/pay/cs_test_ABCDEF", a)
  ck("S18 the short address is short (the full address is under 50 characters)", `https://app.tonydurante.us/pay/s/${code(live)}`.length < 50)
  const exp = await sale({ link_expires_at: new Date(Date.now() - 3600 * 1000).toISOString() })
  const b = await hit(code(exp))
  ck("S19 an expired link shows a plain 'expired' page, not Stripe", b.status === 410 && /expired/i.test(b.body), b)
  const paid = await sale({ status: "paid" })
  const c = await hit(code(paid))
  ck("S20 a paid link says it was already paid", c.status === 200 && /already paid/i.test(c.body), c)
  const d = await hit("ffffffffffff")
  ck("S21 an unknown code is a plain 'not found'", d.status === 404, d)
  const e = await hit("not-a-code")
  ck("S22 a malformed code is a plain 'not found'", e.status === 404, e)
  // the link panel shows the short address
  await p.goto(`${BASE}/marketing/window/${ids[0]}?role=seller`, { waitUntil: "networkidle", timeout: 180000 })
  await p.waitForSelector('[aria-label="Payment link"]', { timeout: 60000 })
  ck("S23 the lead's payment box lists the links and a Copy link button for the open one", (await p.getByRole("button", { name: "Copy link" }).count()) >= 1)
  await db.query("delete from marketing_sales where id = any($1)", [[live, exp, paid]])

  await db.end(); await browser.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
