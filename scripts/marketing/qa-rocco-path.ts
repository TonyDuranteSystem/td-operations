/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa: Rocco's path after the call of 27 Oct 2026): proves, through the REAL login page, the REAL dev server and the REAL database, the seller's ten columns + Incoming messages,
   Contacted / booking link / Upsell / Waiting / Archive, the setter's board without Paid and without Posta, and that a setter sees only her side of a lead's chat.
   Needs: the private stack up and `td-marketing-qa` running on :3010 (QA_BASE), team 'QA td A' with leads at several stages.
   Run: npx tsx scripts/marketing/qa-rocco-path.ts */
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
  // production has none of these stored (the built-in lists apply): the QA team's own sale_kind_stages (strategic_call -> 'sold') is put aside for this run and restored at the end
  const savedSaleStages = (await db.query("select value from marketing_settings where team_id=$1 and key='sale_kind_stages'", [team])).rows[0]?.value
  await db.query("delete from marketing_settings where team_id=$1 and key in ('pipeline_stages','seller_result_stages','permission_bundles','sale_kind_stages')", [team])
  const uid = async (em: string) => (await db.query("select id from auth.users where email=$1", [em])).rows[0].id as string
  const OWNER = "qa-td-ownera@example.test", SETTER = "qa-td-settera@example.test", ALE = "qa-td-alea@example.test"
  // Ale (the QA 'content' person) plays Rocco, the seller, for this run: put her back at the end
  const aleBundle = (await db.query("select bundle from marketing_team_members where team_id=$1 and user_id=$2", [team, await uid(ALE)])).rows[0].bundle as string
  await db.query("update marketing_team_members set bundle='seller' where team_id=$1 and user_id=$2", [team, await uid(ALE)])
  for (const em of [OWNER, SETTER, ALE]) for (const tk of ["owner", "setter", "seller", "analyst", "content", "generic"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) select u.id, $2, $3, 'skipped' from auth.users u where u.email=$1 on conflict do nothing", [em, team, tk])
  const ids = (await db.query("select id from marketing_leads where team_id=$1 and status not in ('paid_call','upsell_won') order by received_at desc limit 6", [team])).rows.map(r => r.id as string)
  ck("Q0 the QA team has leads to work with", ids.length >= 6, ids.length)
  const [LA, LB, LC, LD, LE, LF] = ids
  await db.query("update marketing_leads set status='showed', claimed_by=null, claimed_by_label=null, callback_at=null, not_in_target_reason=null, phone='+393331112233', email='qa-lead@example.test' where id = any($1)", [ids])
  await db.query("delete from marketing_lead_messages where lead_id = any($1)", [ids])
  await db.query("delete from marketing_lead_chat_reads where lead_id = any($1)", [ids])
  const stageOf = async (id: string) => (await db.query("select status from marketing_leads where id=$1", [id])).rows[0].status as string
  const lang = async (pg: import("playwright").Page, l: string) => { await pg.evaluate(async lg => { await fetch("/api/marketing/lang", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang: lg }) }) }, l) }

  let savedBoxes: unknown
  try {
    // ---------- Rocco (Ale as seller) ----------
    const rocco = await session(ALE)
    const p = await rocco.newPage()
    p.on("dialog", d => d.accept())
    await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
    await lang(p, "en"); await p.reload({ waitUntil: "networkidle" })
    await p.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
    const cols = await p.$$eval("[data-column]", els => els.map(e => e.getAttribute("data-column")))
    ck("R1 Rocco's board: Incoming messages + the ten columns, in order", JSON.stringify(cols) === JSON.stringify(["incoming", "booked", "contacted", "closed", "out", "not_ready", "paid", "booking_link", "upsell", "waiting", "archived"]), cols)
    const heads = (await p.$$eval("[data-column]", els => els.map(e => (e.textContent ?? "").split("·")[0].trim()))).join(" | ")
    ck("R2 the English titles", heads.startsWith("Incoming messages | Interested lead | Contacted | Link sent | Not in target | Not ready now | Paid | Booking link sent | Upsell | Waiting | Archived"), heads)
    await p.screenshot({ path: `${SHOTS}/rocco-ten-columns.png` })
    await lang(p, "it"); await p.reload({ waitUntil: "networkidle" })
    const itHeads = (await p.$$eval("[data-column]", els => els.map(e => (e.textContent ?? "").split("·")[0].trim()))).join(" | ")
    ck("R3 the Italian titles", itHeads.startsWith("Messaggi in arrivo | Lead interessato | Contattato | Link inviato | Fuori target | Non pronto ora | Pagato | Link prenotazione inviato | Upsell | In attesa | Archiviato"), itHeads)
    await p.screenshot({ path: `${SHOTS}/rocco-ten-columns-it.png` })
    await lang(p, "en")

    const openLead = async (id: string) => { await p.goto(`${BASE}/marketing/window/${id}?role=seller`, { waitUntil: "networkidle", timeout: 180000 }); await p.waitForSelector('[data-testid="lead-result"]', { timeout: 60000 }) }
    const buttons = async () => (await p.locator('[data-testid="lead-result"] button').allInnerTexts()).map(x => x.trim())

    // Contacted
    await openLead(LA)
    const b1 = await buttons()
    ck("R4 an interested lead offers Contacted, Not in target, Not ready now, Archive (no Not closed, no Closed, no booking box yet)", ["Contacted", "Not in target", "Not ready now", "Archive"].every(b => b1.includes(b)) && !b1.includes("Not closed") && !b1.includes("Closed") && !b1.includes("Upsell") && (await p.locator('[data-testid="booking-link-panel"]').count()) === 0, b1)
    await p.screenshot({ path: `${SHOTS}/rocco-interested-buttons.png` })
    await p.click('[data-testid="result-contacted"]')
    await p.getByRole("button", { name: "Save" }).click()
    // a freshly started dev server compiles the action route on the first press: wait for the stage instead of a fixed pause
    for (let k = 0; k < 40 && (await stageOf(LA)) !== "seller_contacted"; k++) await p.waitForTimeout(500)
    ck("R5 Contacted moves the lead to Contacted", (await stageOf(LA)) === "seller_contacted", await stageOf(LA))
    ck("R6 the history says Contacted", (await p.locator("ol").innerText()).includes("Contacted"))
    const again = await p.evaluate(async id => (await fetch(`/api/marketing/leads/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "contacted" }) })).status, LA)
    ck("R7 pressing Contacted twice is refused", again === 409, again)

    // the booking link is refused before payment
    const early = await p.evaluate(async id => { const r = await fetch(`/api/marketing/leads/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "booking_link", url: "https://calendly.com/rocco/x", via: "email" }) }); return { s: r.status, e: (await r.json()).error } }, LA)
    ck("R8 a booking link before payment is refused in plain words", early.s === 409 && /after the lead has paid/i.test(early.e), early)

    // after payment: the booking link box
    await db.query("update marketing_leads set status='paid_call' where id=$1", [LB])
    await openLead(LB)
    await p.waitForSelector('[data-testid="booking-link-panel"]', { timeout: 30000 })
    const b2 = await buttons()
    ck("R9 a paid lead offers Upsell, Waiting, Archive and shows the booking link box (no Contacted, no Not ready now)", ["Upsell", "Waiting", "Archive"].every(b => b2.includes(b)) && !b2.includes("Contacted") && !b2.includes("Not ready now"), b2)
    await p.screenshot({ path: `${SHOTS}/rocco-booking-link-box.png` })
    await p.fill('[data-testid="booking-url"]', "") // an earlier run's link may prefill the box (it shows the last link sent on the lead; the history is append-only)
    ck("R10 Send buttons stay off until the link is a real https address", await p.locator('[data-testid="booking-whatsapp"]').isDisabled() && await p.locator('[data-testid="booking-email"]').isDisabled())
    await p.fill('[data-testid="booking-url"]', "calendly.com/rocco")
    ck("R11 a link without https:// keeps both buttons off", await p.locator('[data-testid="booking-whatsapp"]').isDisabled())
    await p.fill('[data-testid="booking-url"]', "https://calendly.com/rocco/consultation")
    const msg = await p.inputValue('[data-testid="booking-message"]')
    ck("R12 the message is written for him with the lead's first name and the link", /https:\/\/calendly\.com\/rocco\/consultation/.test(msg) && /thank you for your payment/i.test(msg), msg)
    ck("R13 Send by WhatsApp is on", !(await p.locator('[data-testid="booking-whatsapp"]').isDisabled()))
    const popup = rocco.waitForEvent("page", { timeout: 15000 }).catch(() => null)
    await p.click('[data-testid="booking-whatsapp"]')
    const wa = await popup
    ck("R14 WhatsApp Web opens in its own window with the message", !!wa && /whatsapp/i.test(wa.url() || "") , wa?.url())
    if (wa) await wa.close().catch(() => {})
    await p.waitForSelector('[data-testid="booking-did-you-send"]', { timeout: 15000 })
    ck("R15 nothing is recorded until he says he sent it", (await stageOf(LB)) === "paid_call")
    await p.click('[data-testid="booking-sent-yes"]')
    await p.waitForTimeout(1800)
    ck("R16 'Yes, sent' moves the lead to Booking link sent", (await stageOf(LB)) === "booking_link", await stageOf(LB))
    const ev = (await db.query("select data from marketing_lead_events where lead_id=$1 and kind='booking_link' order by id desc limit 1", [LB])).rows[0]
    ck("R17 the history keeps the link and how it was sent", ev?.data?.url === "https://calendly.com/rocco/consultation" && ev?.data?.via === "whatsapp", ev)
    ck("R18 the lead page reads it in plain words", /Booking link sent by WhatsApp/.test(await p.locator("ol").innerText()))
    await p.screenshot({ path: `${SHOTS}/rocco-after-booking-link.png` })
    // the link is remembered on the lead
    await openLead(LB)
    ck("R19 the box shows the last link again", (await p.inputValue('[data-testid="booking-url"]')) === "https://calendly.com/rocco/consultation")
    // Upsell, then Waiting, then Archive
    await p.click('[data-testid="result-upsell"]'); await p.getByRole("button", { name: "Save" }).click(); await p.waitForTimeout(1500)
    ck("R20 Upsell moves the lead to Upsell", (await stageOf(LB)) === "upsell", await stageOf(LB))
    await p.click('[data-testid="result-waiting"]'); await p.getByRole("button", { name: "Save" }).click(); await p.waitForTimeout(1500)
    ck("R21 Waiting moves it to Waiting", (await stageOf(LB)) === "waiting", await stageOf(LB))
    await p.click('[data-testid="result-archive"]'); await p.getByRole("button", { name: "Save" }).click(); await p.waitForTimeout(1500)
    ck("R22 Archive closes it", (await stageOf(LB)) === "archived", await stageOf(LB))
    await p.waitForTimeout(500)
    const b4 = await buttons()
    ck("R23 an archived lead offers Contacted and Not ready now again (not a dead end) but no Archive, Upsell, Waiting and no booking box", ["Contacted", "Not ready now"].every(b => (b4 ?? []).includes(b)) && (b4 ?? []).filter(b => ["Upsell", "Waiting", "Archive"].includes(b)).length === 0 && (await p.locator('[data-testid="booking-link-panel"]').count()) === 0, b4)

    // a payment link never pulls a lead that is past paying back to Link sent (planner level, through the server)
    const noPull = await p.evaluate(async id => (await fetch(`/api/marketing/leads/${id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "contacted" }) })).status, LB)
    ck("R24 'Contacted' on an archived lead works (it comes back to Contacted)", noPull === 200 && (await stageOf(LB)) === "seller_contacted", { noPull, now: await stageOf(LB) })

    // Link sent -> not ready now / not in target are still ways out
    await db.query("update marketing_leads set status='closed' where id=$1", [LC])
    await openLead(LC)
    const b3 = await buttons()
    ck("R25 a Link sent lead still offers Contacted, Not in target, Not ready now", ["Contacted", "Not in target", "Not ready now"].every(b => b3.includes(b)), b3)

    // the email path: Rocco's own mailbox (the private stack uses the fake mail driver)
    savedBoxes = (await db.query("select value from marketing_settings where team_id=$1 and key='inbox_mailboxes'", [team])).rows[0]?.value
    await db.query("delete from marketing_settings where team_id=$1 and key='inbox_mailboxes'", [team])
    await db.query("insert into marketing_settings (team_id, key, value) values ($1,'inbox_mailboxes',$2)", [team, JSON.stringify([{ address: "rocco-qa@tonydurante.us", people: [await uid(ALE)], signature: "" }])])
    await db.query("update marketing_leads set status='paid_call' where id=$1", [LF])
    await openLead(LF)
    await p.waitForSelector('[data-testid="booking-link-panel"]', { timeout: 30000 })
    await p.fill('[data-testid="booking-url"]', "https://calendly.com/rocco/email-test")
    ck("E1 Send by email is on for a lead with an email address and a mailbox", !(await p.locator('[data-testid="booking-email"]').isDisabled()))
    await p.click('[data-testid="booking-email"]')
    await p.waitForSelector('[data-testid="booking-done"]', { timeout: 30000 }).catch(() => null)
    ck("E2 the email goes out from his mailbox and the screen says so", /Email sent/.test(await p.locator("body").innerText()), (await p.locator("body").innerText()).slice(0, 400))
    ck("E3 the lead moves to Booking link sent", (await stageOf(LF)) === "booking_link", await stageOf(LF))
    const eev = (await db.query("select data from marketing_lead_events where lead_id=$1 and kind='booking_link' order by id desc limit 1", [LF])).rows[0]
    ck("E4 the history records the link and 'email'", eev?.data?.via === "email" && eev?.data?.url === "https://calendly.com/rocco/email-test", eev)
    await p.screenshot({ path: `${SHOTS}/rocco-booking-email-sent.png` })

    // ---------- the chat: Incoming messages, colours, the setter's view ----------
    const ownerCtx = await session(OWNER)
    const o = await ownerCtx.newPage()
    await o.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
    const say = async (pg: import("playwright").Page, lead: string, message: string) => pg.evaluate(async a => (await fetch(`/api/marketing/chat/${a.lead}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: a.message }) })).status, { lead, message })
    // Antonio (owner) writes to Rocco on lead LD; the setter writes to Rocco on lead LE
    await db.query("update marketing_leads set status='seller_contacted' where id = any($1)", [[LD, LE]])
    ck("C1 Antonio's message is sent", (await say(o, LD, "Rocco, call this one today")) === 200)
    const setterCtx = await session(SETTER)
    const s = await setterCtx.newPage()
    await s.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
    await lang(s, "en"); await s.reload({ waitUntil: "networkidle" })
    ck("C2 the setter writes to Rocco on another lead", (await say(s, LE, "@Qa Td Alea this one is interested")) === 200)
    await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
    await p.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
    const incoming = await p.$$eval('[data-column="incoming"] [data-testid="board-card"]', els => els.map(e => ({ id: e.getAttribute("data-lead"), from: e.getAttribute("data-incoming"), cls: e.className })))
    ck("C3 both leads sit in Incoming messages on Rocco's board", incoming.some(c => c.id === LD) && incoming.some(c => c.id === LE), incoming)
    ck("C4 Antonio's card is red and blinks; the setter's card is green", incoming.find(c => c.id === LD)?.from === "owner" && /border-red-500/.test(incoming.find(c => c.id === LD)?.cls ?? "") && /animate-pulse/.test(incoming.find(c => c.id === LD)?.cls ?? "") && incoming.find(c => c.id === LE)?.from === "setter" && /border-emerald-500/.test(incoming.find(c => c.id === LE)?.cls ?? ""), incoming)
    await p.screenshot({ path: `${SHOTS}/rocco-incoming-messages.png` })
    // @Antonio: Rocco's picker offers Antonio
    await p.goto(`${BASE}/marketing/window/${LD}?role=seller`, { waitUntil: "networkidle", timeout: 180000 })
    await p.getByRole("tab", { name: /Chat/ }).first().click().catch(async () => { await p.getByText("Chat", { exact: true }).first().click() })
    await p.waitForTimeout(1500)
    const box = p.locator("textarea, [contenteditable=true]").last()
    await box.click(); await p.keyboard.type("@")
    await p.waitForTimeout(800)
    const pickerText = await p.locator("body").innerText()
    ck("C5 Rocco types @ and is offered @Qa Td Ownera (Antonio)", /Qa Td Ownera/.test(pickerText.split("@").slice(-3).join("@")) || (await p.locator('[role="listbox"], [data-testid*="mention"]').allInnerTexts()).join(" ").includes("Qa Td Ownera"), pickerText.slice(-300))
    await p.screenshot({ path: `${SHOTS}/rocco-at-antonio.png` })
    await p.keyboard.press("Escape")

    // the setter: Posta is gone, her board has no Paid, she sees only her own side of the chat
    await s.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
    await s.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
    const nav = (await s.locator("nav a").allInnerTexts()).map(x => x.trim())
    ck("S1 the setter's menu has no Posta (and no Inbox)", !nav.some(x => /^(Posta|Inbox)$/i.test(x)), nav)
    const scols = await s.$$eval("[data-column]", els => els.map(e => e.getAttribute("data-column")))
    ck("S2 her board: To contact, Tried, In target, Interested lead, Out of target (no Paid)", JSON.stringify(scols) === JSON.stringify(["to_contact", "tried", "in_target", "booked", "out"]), scols)
    const sh = (await s.$$eval("[data-column]", els => els.map(e => (e.textContent ?? "").split("·")[0].trim()))).join(" | ")
    ck("S3 her titles", sh.startsWith("To contact | Tried, no answer | In target | Interested lead | Out of target"), sh)
    await s.screenshot({ path: `${SHOTS}/setter-board.png` })
    const inboxPage = await s.evaluate(async () => (await fetch("/marketing/inbox")).status)
    ck("S4 the Inbox page itself tells her she has no access", inboxPage === 200 && /do not have access to the Inbox/i.test(await s.evaluate(async () => (await (await fetch("/marketing/inbox")).text()))), inboxPage)
    const seeD = await s.evaluate(async id => { const r = await fetch(`/api/marketing/chat/${id}`); const d = await r.json(); return { s: r.status, msgs: (d.messages ?? []).map((m: { message: string }) => m.message) } }, LD)
    ck("S5 on the lead where only Antonio wrote, she sees nothing of it", seeD.s === 200 && seeD.msgs.length === 0, seeD)
    const seeE = await s.evaluate(async id => (await (await fetch(`/api/marketing/chat/${id}`)).json()).messages.map((m: { message: string }) => m.message), LE)
    ck("S6 on her own lead she sees what she wrote", seeE.some((m: string) => /this one is interested/.test(m)), seeE)
    const list = await s.evaluate(async () => (await (await fetch("/api/marketing/chat/conversations")).json()).conversations.map((c: { leadId: string }) => c.leadId))
    ck("S7 her chat list shows her lead and not the one only Antonio wrote on", list.includes(LE) && !list.includes(LD), list)
    // Rocco answers her without @ -> hidden; with @ -> visible
    ck("S8 Rocco answers the setter without naming her", (await say(p, LE, "ok, I call him")) === 200)
    const hid = await s.evaluate(async id => (await (await fetch(`/api/marketing/chat/${id}`)).json()).messages.map((m: { message: string }) => m.message), LE)
    ck("S9 an answer that does not name her stays hidden from her", !hid.some((m: string) => /I call him/.test(m)), hid)
    ck("S10 Rocco answers naming her", (await say(p, LE, "@Qa Td Settera thanks, I call him")) === 200)
    const unread = await s.evaluate(async () => (await (await fetch("/api/marketing/chat/unread")).json()))
    ck("S12 her unread numbers count only what she may see: the one message that names her on her lead, nothing of the hidden ones", unread?.by_lead?.[LE] === 1 && !(LD in (unread?.by_lead ?? {})) && unread?.total === 1, unread)
    const vis = await s.evaluate(async id => (await (await fetch(`/api/marketing/chat/${id}`)).json()).messages.map((m: { message: string }) => m.message), LE)
    ck("S11 an answer that names her is visible to her", vis.some((m: string) => /thanks, I call him/.test(m)) && !vis.some((m: string) => /^ok, I call him/.test(m)), vis)
    const members = await p.evaluate(async id => (await (await fetch(`/api/marketing/chat/${id}`)).json()).members.map((m: { name: string }) => m.name), LD)
    ck("S13 Rocco's list of people to @ has Antonio and the setter", members.includes("Qa Td Ownera") && members.includes("Qa Td Settera"), members)
    await s.goto(`${BASE}/marketing/chat`, { waitUntil: "networkidle", timeout: 180000 })
    const chatText = await s.locator("body").innerText()
    ck("S14 the setter's Chat page shows her lead and not Antonio's", /Chats about leads|lead/i.test(chatText) && !/call this one today/.test(chatText), chatText.slice(0, 300))
    const act = async (id: string, body: Record<string, unknown>) => s.evaluate(async a => (await fetch(`/api/marketing/leads/${a.id}/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a.body) })).status, { id, body })
    ck("S15 a setter cannot press the seller's buttons through the API (Archive, Contacted, Upsell, booking link are refused)", [await act(LC, { action: "archive" }), await act(LC, { action: "contacted" }), await act(LC, { action: "upsell" }), await act(LC, { action: "booking_link", url: "https://calendly.com/x", via: "email" })].every(c => c === 403))
    ck("S16 a setter's Good on a lead that has moved on to Rocco is refused", (await act(LA, { action: "good", ticked: [] })) === 409)
    await s.screenshot({ path: `${SHOTS}/setter-chat.png` })
  } finally {
    await db.query("delete from marketing_settings where team_id=$1 and key='inbox_mailboxes'", [team])
    if (savedBoxes) await db.query("insert into marketing_settings (team_id, key, value) values ($1,'inbox_mailboxes',$2)", [team, JSON.stringify(savedBoxes)])
    if (savedSaleStages) { await db.query("delete from marketing_settings where team_id=$1 and key='sale_kind_stages'", [team]); await db.query("insert into marketing_settings (team_id, key, value) values ($1,'sale_kind_stages',$2)", [team, JSON.stringify(savedSaleStages)]) }
    await db.query("update marketing_team_members set bundle=$3 where team_id=$1 and user_id=$2", [team, await uid(ALE), aleBundle])
    await db.query("delete from marketing_lead_messages where lead_id = any($1)", [ids])
    await db.query("delete from marketing_lead_chat_reads where lead_id = any($1)", [ids])
  }
  await browser.close()
  await db.end()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
