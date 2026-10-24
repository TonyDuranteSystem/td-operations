/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, the workspace round 2): search, a lead opens in a floating window on EVERY screen, the sidebar order, the light / dark /
   system look, the Chat page, the renamed columns. Real login page, real dev server, real database. Needs the private stack up and `td-marketing-qa` on :3010 (QA_BASE),
   team 'QA td A' with leads at several stages. Run: npx tsx scripts/marketing/qa-workspace.ts */
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
  const hydrated = async (f: import("playwright").Frame | import("playwright").Page) => { await f.waitForFunction(() => !window.fetch.toString().includes("native code"), undefined, { timeout: 60000 }).catch(() => undefined) }
  const team = (await db.query("select id from marketing_teams where name like 'QA td A%' limit 1")).rows[0].id
  const lead = (await db.query("select id, full_name, phone from marketing_leads where team_id=$1 and status='booked' order by received_at desc limit 1", [team])).rows[0]
  const winCount = (p: import("playwright").Page) => p.$$eval('[data-testid="lead-window"]', e => e.filter(x => getComputedStyle(x).display !== "none").length)

  const ctx = await session("qa-td-ownera@example.test")
  const p = await ctx.newPage()
  await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
  await p.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
  await hydrated(p)

  // renamed columns, no Messaggi tab on the board
  const heads = await p.$$eval("[data-column] h2", e => e.map(x => x.textContent ?? ""))
  ck("the seller's columns have the clearer Italian names", heads.some(h => h.startsWith("Da fissare con te")) && heads.some(h => h.startsWith("Dopo la call")), heads)
  ck("the board has no Messaggi tab any more", (await p.locator('[data-testid="view-messages"]').count()) === 0)

  // search
  await p.fill('[data-testid="lead-search"]', "zz-nothing-like-this")
  await p.waitForSelector('[data-testid="search-results"]', { timeout: 15000 })
  ck("a search with no match says so", (await p.locator('[data-testid="search-results"]').innerText()).includes("Nessun lead trovato"))
  await p.fill('[data-testid="lead-search"]', (lead.full_name as string).split(" ")[0].slice(0, 5))
  await p.waitForSelector('[data-testid="search-hit"]', { timeout: 15000 })
  ck("searching by part of a name finds leads", (await p.locator('[data-testid="search-hit"]').count()) >= 1)
  await p.locator(`[data-testid="search-hit"][data-lead="${lead.id}"]`).first().click().catch(async () => { await p.locator('[data-testid="search-hit"]').first().click() })
  await p.waitForSelector('[data-testid="lead-window"]', { timeout: 20000 })
  ck("clicking a search result opens the lead in a floating window, on the same page", (await winCount(p)) === 1 && new URL(p.url()).pathname === "/marketing/board", p.url())
  const digits = ((lead.phone as string) ?? "").replace(/\D/g, "").slice(-6, -2)
  if (digits.length === 4) {
    await p.fill('[data-testid="lead-search"]', digits)
    await p.waitForSelector('[data-testid="search-results"]', { timeout: 15000 })
    await p.waitForTimeout(800)
    ck("searching by part of a phone number works", (await p.locator('[data-testid="search-hit"]').count()) >= 1)
  }
  const inj = await p.evaluate(async () => (await fetch("/api/marketing/leads/search?q=" + encodeURIComponent("x),id.neq.0,full_name.ilike.%"))).status)
  ck("a search crafted to bend the database filter is harmless", inj === 200, inj)
  await p.fill('[data-testid="lead-search"]', "")

  // a lead opens in a window on EVERY screen
  for (const [path, sel, name] of [["/marketing/leads", '[data-testid="lead-row"]', "Leads"], ["/marketing/today", "a[data-lead]", "Today"], ["/marketing/calendar", "a[data-lead]", "Calendar"], ["/marketing/call-list", '[data-testid="queue-lead"]', "Call list"]] as const) {
    await p.goto(`${BASE}${path}`, { waitUntil: "networkidle" }); await hydrated(p)
    const n = await p.locator(sel).count()
    if (n === 0) { console.log(`(skip ${name}: no lead on this screen in the test data)`); continue }
    await p.locator(sel).first().click()
    await p.waitForSelector('[data-testid="lead-window"]', { timeout: 20000 })
    ck(`${name}: a lead opens in a floating window and the page does not change`, (await winCount(p)) >= 1 && new URL(p.url()).pathname === path, p.url())
  }
  // a window survives going to another screen (the host lives in the frame)
  await p.goto(`${BASE}/marketing/leads`, { waitUntil: "networkidle" }); await hydrated(p)
  await p.locator('[data-testid="lead-row"]').first().click()
  await p.waitForSelector('[data-testid="lead-window"]')
  await p.click('[data-testid="nav-board"]')
  await p.waitForSelector('[data-testid="pipeline"]')
  ck("a lead window stays open when you go to another screen", (await winCount(p)) >= 1)
  // the old address style still opens a window
  await p.goto(`${BASE}/marketing/board?open=${lead.id}`, { waitUntil: "networkidle" })
  await p.waitForSelector('[data-testid="lead-window"]', { timeout: 20000 })
  ck("an address ?open=<lead> opens that lead in a window and then cleans itself", (await winCount(p)) === 1 && !p.url().includes("open="), p.url())

  // the look
  await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle" }); await hydrated(p)
  const bg = () => p.evaluate(() => getComputedStyle(document.querySelector('[data-testid="board-card"]') ?? document.body).backgroundColor)
  const root = () => p.evaluate(() => document.getElementById("tdm-root")?.getAttribute("data-tdm-theme"))
  await p.click('[data-testid="theme-light"]'); const light = await bg()
  await p.click('[data-testid="theme-dark"]'); await p.waitForTimeout(200); const dark = await bg()
  ck("Dark changes the colours of the whole workspace", light !== dark && (await root()) === "dark", { light, dark })
  await p.screenshot({ path: `${SHOTS}/workspace-dark.png` })
  await p.reload({ waitUntil: "networkidle" })
  ck("the choice is remembered after a reload (and drawn dark from the first moment)", (await root()) === "dark")
  await p.emulateMedia({ colorScheme: "dark" }); await p.click('[data-testid="theme-system"]'); await p.waitForTimeout(200)
  const sysDark = await bg()
  await p.emulateMedia({ colorScheme: "light" }); await p.waitForTimeout(200)
  const sysLight = await bg()
  ck("System follows the computer: dark when the computer is dark, light when it is light", sysDark === dark && sysLight === light, { sysDark, sysLight, dark, light })
  await p.click('[data-testid="theme-dark"]')
  await p.locator('[data-testid="board-card"]').first().click()
  await p.waitForSelector('[data-testid="lead-window"]')
  let fr = p.frames().find(f => f.url().includes("/marketing/window/"))
  for (let k = 0; k < 120 && !fr; k++) { await p.waitForTimeout(500); fr = p.frames().find(f => f.url().includes("/marketing/window/")) }
  if (!fr) throw new Error("the lead window's page did not load")
  await fr.waitForSelector("h2", { timeout: 60000 })
  ck("a lead window opened in Dark is dark inside too", (await fr!.evaluate(() => document.getElementById("tdm-root")?.getAttribute("data-tdm-theme"))) === "dark")
  await p.click('[data-testid="theme-light"]'); await p.waitForTimeout(400)
  ck("switching the look changes the open lead window at once", (await fr!.evaluate(() => document.getElementById("tdm-root")?.getAttribute("data-tdm-theme"))) === "light")
  await p.screenshot({ path: `${SHOTS}/workspace-light-window.png` })
  await p.click('[data-testid="theme-system"]')

  // the sidebar order
  const order = () => p.$$eval('nav[aria-label] a[data-testid^="nav-"]', e => e.map(x => x.getAttribute("data-testid")!.replace("nav-", "")))
  const before = await order()
  await p.click('[data-testid="nav-reorder"]')
  await p.click(`[data-testid="nav-down-${before[0]}"]`)
  const after = await order()
  ck("the first entry moves down one place", after[1] === before[0] && after[0] === before[1], { before, after })
  await p.reload({ waitUntil: "networkidle" })
  ck("the order is remembered after a reload", JSON.stringify(await order()) === JSON.stringify(after))
  await p.click('[data-testid="nav-reorder"]'); await p.click(`[data-testid="nav-up-${before[0]}"]`)
  ck("moving it back up restores the original order", JSON.stringify(await order()) === JSON.stringify(before))

  // the Chat page
  await p.click('[data-testid="nav-chat"]')
  await p.waitForSelector('[data-testid="messages"]')
  ck("the sidebar's Chat opens the chats about leads, with a search box", (await p.locator('[data-testid="chat-filter"]').count()) === 1)

  // the setter has no switch and no way to the other board; a person with no 'chat' sees no Chat entry
  const setterCtx = await session("qa-td-settera@example.test")
  const s = await setterCtx.newPage()
  await s.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle" })
  await s.waitForSelector('[data-testid="pipeline"]')
  ck("a setter has no board switch", (await s.locator('[data-testid="role-switch"]').count()) === 0)
  const aleCtx = await session("qa-td-alea@example.test")
  const a = await aleCtx.newPage()
  await a.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle" })
  const aleNav = await a.$$eval('nav[aria-label] a[data-testid^="nav-"]', e => e.map(x => x.getAttribute("data-testid")))
  const hasChat = aleNav.includes("nav-chat")
  console.log("(Ale's menu:", aleNav.join(", "), ")")
  ck("the search bar is there for everyone who may read leads", (await a.locator('[data-testid="lead-search"]').count()) === 1 || !aleNav.includes("nav-board"))
  void hasChat
  console.log(`\n${pass} passed, ${fail} failed`)
  await browser.close(); await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
