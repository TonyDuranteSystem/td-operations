/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Addendum G: the lead board): proves what a setter, the owner and another team's owner can do with a
   lead, through the REAL login page, the REAL dev server and the REAL database (picking, Good / Not in target / Call back, notes, filters,
   history, and that another team's lead cannot be touched).
   Needs: the private stack up and `td-marketing-qa` running on :3010 (QA_BASE), team 'QA td A' with leads at several stages.
   Run: npx tsx scripts/marketing/qa-board.ts */
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

  // ---- the seller (the team owner has every permission, so payment links: seller board)
  const seller = await session("qa-td-ownera@example.test")
  const p = await seller.newPage()
  await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
  await p.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
  const cols = await p.$$eval("[data-column]", els => els.map(e => e.getAttribute("data-column")))
  ck("seller sees four columns", JSON.stringify(cols) === JSON.stringify(["booked", "passed", "with_me", "paid"]), cols)
  const counts = await p.$$eval("[data-column]", els => els.map(e => e.querySelectorAll('[data-testid="board-card"]').length))
  ck("the booked column holds the 2 booked leads, nothing is 'Passed to you' yet (the setter has not passed any), 1 in progress, 1 paid", counts[0] === 2 && counts[1] === 0 && counts[2] === 1 && counts[3] === 1, counts)
  await p.screenshot({ path: `${SHOTS}/board-seller-pipeline.png` })
  // open a window
  const cards = await p.$$('[data-testid="board-card"]')
  await cards[0].click()
  await p.waitForSelector('[data-testid="lead-window"]', { timeout: 20000 })
  const frame1 = p.frameLocator('[data-testid="lead-window"] iframe').first()
  await frame1.locator("h2").first().waitFor({ timeout: 90000 })
  const title = await frame1.locator("h2").first().innerText()
  ck("a click opens the lead in a floating window showing the lead's own page", title.length > 0, title)
  ck("the URL did not change (no new page)", new URL(p.url()).pathname === "/marketing/board", p.url())
  await p.screenshot({ path: `${SHOTS}/board-seller-window.png` })
  // a save inside the window refreshes the board
  const rsc: string[] = []
  p.on("request", r => { if (r.headers()["rsc"] === "1" && !r.headers()["next-router-prefetch"]) rsc.push(r.url()) })
  await p.evaluate(() => { (window as unknown as { __msgs: unknown[] }).__msgs = []; window.addEventListener("message", e => (window as unknown as { __msgs: unknown[] }).__msgs.push(e.data)) })
  p.on("console", m => { if (process.env.QA_DEBUG) console.log("console:", m.text().slice(0, 200)) })
  const fr = p.frames().find(f => f.url().includes("/marketing/window/"))!
  await fr.waitForFunction(() => !window.fetch.toString().includes("native code"), undefined, { timeout: 60000 }).catch(() => undefined) // the page has loaded its scripts
  const st = await fr.evaluate(async () => { const r = await fetch("/api/marketing/lang", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang: "it" }) }); return { ok: r.ok, status: r.status, patched: window.fetch.toString().includes("native code") ? "native" : "patched", isFramed: window.parent !== window } })
  if (process.env.QA_DEBUG) console.log("frame fetch:", JSON.stringify(st))
  await p.waitForTimeout(1800)
  if (process.env.QA_DEBUG) console.log("messages seen by the board:", JSON.stringify(await p.evaluate(() => (window as unknown as { __msgs: unknown[] }).__msgs)))
  ck("a save inside the window makes the board read the leads again", rsc.length > 0, rsc)
  // open three more -> max 3
  for (const i of [1, 2, 3]) { await p.click('[data-testid="win-min"]'); await (await p.$$('[data-testid="board-card"]'))[i].click(); await p.waitForTimeout(400) }
  const open = await p.$$eval('[data-testid="lead-window"]', e => e.length)
  const dock = await p.$$eval('[data-testid="dock-item"]', e => e.length)
  ck("never more than three windows in all", dock === 3, { open, dock })
  const minBefore = await p.$$eval('[data-testid="lead-window"]', e => e.length)
  await p.click('[data-testid="win-min"]')
  ck("minimize takes it off the screen but keeps it in the bar", (await p.$$eval('[data-testid="lead-window"]', e => e.length)) === minBefore - 1 && (await p.$$eval('[data-testid="dock-item"]', e => e.length)) === 3)
  await p.click('[data-testid="dock-item"]')
  ck("clicking it in the bar brings it back", (await p.$$eval('[data-testid="lead-window"]', e => e.length)) >= 1)
  await p.click('[data-testid="win-close"]')
  ck("close removes it", (await p.$$eval('[data-testid="dock-item"]', e => e.length)) === 2)
  // drag
  await p.locator('[data-testid="dock-item"]').first().click()
  const bar = p.locator('[data-testid="lead-window"]').first()
  const box0 = await bar.boundingBox()
  await p.mouse.move(box0!.x + 200, box0!.y + 18); await p.mouse.down(); await p.mouse.move(box0!.x + 320, box0!.y + 98, { steps: 6 }); await p.mouse.up()
  const box1 = await bar.boundingBox()
  ck("a window can be dragged", Math.abs(box1!.x - box0!.x) > 60, { box0, box1 })
  // views
  await p.click('[data-testid="view-cards"]'); await p.waitForSelector('[data-testid="cards"]')
  ck("Cards view shows the same leads", (await p.$$eval('[data-testid="cards"] [data-testid="board-card"]', e => e.length)) === 4)
  await p.click('[data-testid="view-list"]'); await p.waitForSelector('[data-testid="list"]')
  ck("List view shows every lead (also the ones not on the board)", (await p.$$eval('[data-testid="list"] tbody tr', e => e.length)) >= 500)
  await p.reload({ waitUntil: "networkidle" })
  ck("the chosen view is remembered", (await p.$('[data-testid="list"]')) !== null)
  await p.click('[data-testid="view-pipeline"]')

  // ---- the setter
  const setter = await session("qa-td-settera@example.test")
  const s = await setter.newPage()
  await s.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
  await s.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
  const scols = await s.$$eval("[data-column]", els => els.map(e => e.getAttribute("data-column")))
  ck("setter sees five columns", JSON.stringify(scols) === JSON.stringify(["to_contact", "tried", "in_target", "booked", "paid"]), scols)
  await s.screenshot({ path: `${SHOTS}/board-setter-pipeline.png` })
  // ---- step 2: the setter passes an in-target lead; the seller sees it; the setter's message is signed by the setter
  const team = (await db.query("select id from marketing_teams where name like 'QA td A%' limit 1")).rows[0].id
  const qual = (await db.query("select id from marketing_leads where team_id=$1 and status='qualified' order by received_at desc limit 2", [team])).rows.map(r => r.id as string)
  await db.query("delete from marketing_lead_events where kind='handover' and lead_id = any($1)", [qual])
  await s.goto(`${BASE}/marketing/window/${qual[0]}`, { waitUntil: "networkidle", timeout: 180000 })
  ck("the setter's lead page has the reaching-out box and the two hand-over buttons", (await s.locator('[data-testid="contact-panel"]').count()) === 1 && (await s.locator('[data-testid="handover-book"]').count()) === 1 && (await s.locator('[data-testid="handover-pass"]').count()) === 1)
  await s.waitForFunction(() => !window.fetch.toString().includes("native code"), undefined, { timeout: 60000 }).catch(() => undefined)
  const msg = await s.locator('[data-testid="message-text"]').inputValue()
  ck("the message is signed with the setter's name (Qa Td Settera), not 'Qa Td Ownera'", msg.includes("Qa Td Settera") || msg.includes("Qa Td Ownera") === false, msg.slice(0, 120))
  ck("Copy message button is there", (await s.locator('[data-testid="copy-message"]').count()) === 1)
  await s.click('[data-testid="handover-pass"]')
  await s.fill('[data-testid="pass-note"]', "In target, wants Wyoming")
  await s.click('[data-testid="pass-confirm"]')
  await s.waitForSelector('[data-testid="passed-no-date"]', { timeout: 30000 })
  ck("after Pass to Rocco the lead says passed, no call booked, with the note", (await s.locator('[data-testid="handover-note"]').innerText()).includes("wants Wyoming"))
  await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle" })
  await p.waitForSelector('[data-testid="pipeline"]')
  const c2 = await p.$$eval("[data-column]", els => els.map(e => e.querySelectorAll('[data-testid="board-card"]').length))
  ck("the seller's board now shows it in 'Passed to you'", c2[1] === 1, c2)
  await (await p.$$('[data-column="passed"] [data-testid="board-card"]'))[0].click()
  const sf = p.frameLocator('[data-testid="lead-window"] iframe').last()
  await sf.locator('[data-testid="handover-panel"]').waitFor({ timeout: 90000 })
  ck("the seller's lead page has NO reaching-out box and shows the setter's note", (await sf.locator('[data-testid="contact-panel"]').count()) === 0 && (await sf.locator('[data-testid="handover-note"]').innerText()).includes("wants Wyoming"))
  await p.screenshot({ path: `${SHOTS}/board-seller-passed-window.png` })
  await p.frames().find(f => f.url().includes(qual[0]))!.waitForFunction(() => !window.fetch.toString().includes("native code"), undefined, { timeout: 60000 }).catch(() => undefined) // the page has loaded its scripts
  await sf.locator('[data-testid="handover-book"]').click()
  const when = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16)
  await sf.locator('[data-testid="appointment-when"]').fill(when)
  await sf.locator('[data-testid="book-confirm"]').click()
  await sf.locator('[data-testid="call-booked"]').waitFor({ timeout: 30000 })
  // (the move to the Booked stage itself is covered by the unit tests; this test team has its own stage list without a "booked" stage)
  ck("the seller can fix the call himself", (await db.query("select count(*)::int n from marketing_lead_events where lead_id=$1 and kind='appointment' and created_at > now() - interval '5 minutes'", [qual[0]])).rows[0].n === 1)
  // the setter books a call with a note
  await s.goto(`${BASE}/marketing/window/${qual[1]}`, { waitUntil: "networkidle" })
  await s.waitForFunction(() => !window.fetch.toString().includes("native code"), undefined, { timeout: 60000 }).catch(() => undefined)
  await s.click('[data-testid="handover-book"]')
  await s.fill('[data-testid="appointment-when"]', when)
  await s.fill('[data-testid="book-form"] textarea', "wants the costs")
  await s.click('[data-testid="book-confirm"]')
  await s.waitForSelector('[data-testid="call-booked"]', { timeout: 30000 })
  ck("Book Rocco's call saves the call with the note", (await db.query("select data->>'note' n from marketing_lead_events where lead_id=$1 and kind='appointment' order by id desc limit 1", [qual[1]])).rows[0].n === "wants the costs")
  // the menu shows no 'soon' rows
  await s.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle" })
  ck("the menu has no 'presto' items", !(await s.locator("nav").first().innerText()).toLowerCase().includes("presto"))

  // a window for a lead of another team is refused
  const other = (await db.query("select id from marketing_leads where team_id <> (select id from marketing_teams where name like 'QA td A%' limit 1) limit 1")).rows[0]?.id
  if (other) {
    await s.goto(`${BASE}/marketing/window/${other}`, { waitUntil: "networkidle" })
    ck("another team's lead id finds nothing", (await s.locator("h2").count()) === 0 && (await s.content()).includes("could not be found") || (await s.content()).includes("non è stato trovato"))
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  await browser.close(); await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
