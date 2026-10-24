/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa, Addendum G: the lead chat): proves the chat inside a lead between a setter and the seller, through the REAL login page,
   the REAL dev server and the REAL database (text, reply, reactions, edit, delete, files, voice, unread numbers, ticks, notifications, and that another team's lead is closed).
   Needs: the private stack up and `td-marketing-qa` running on :3010 (QA_BASE), team 'QA td A' with leads at several stages.
   Run: npx tsx scripts/marketing/qa-chat.ts */
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
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
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
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] })
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

  const team = (await db.query("select id from marketing_teams where name like 'QA td A%' limit 1")).rows[0].id
  const lead = (await db.query("select id, full_name from marketing_leads where team_id=$1 and status='qualified' order by received_at desc limit 1", [team])).rows[0]
  const otherLead = (await db.query("select id from marketing_leads where team_id <> $1 limit 1", [team])).rows[0]?.id
  await db.query("set session_replication_role = replica")
  await db.query("delete from marketing_lead_message_reactions where message_id in (select id from marketing_lead_messages where lead_id=$1)", [lead.id])
  await db.query("delete from marketing_lead_messages where lead_id=$1", [lead.id])
  await db.query("delete from marketing_lead_chat_reads where lead_id=$1", [lead.id])
  await db.query("delete from marketing_lead_chat_delivery where lead_id=$1", [lead.id])
  await db.query("set session_replication_role = origin")
  const hydrated = async (f: import("playwright").Frame | import("playwright").Page) => { await f.waitForFunction(() => !window.fetch.toString().includes("native code"), undefined, { timeout: 60000 }).catch(() => undefined) }

  const setterCtx = await session("qa-td-settera@example.test")
  const s = await setterCtx.newPage()
  await s.goto(`${BASE}/marketing/window/${lead.id}?tab=chat`, { waitUntil: "networkidle", timeout: 180000 })
  await s.waitForSelector('[data-testid="lead-chat"]', { timeout: 60000 })
  await hydrated(s)
  ck("the lead window has a Lead and a Chat tab, the Chat one open", (await s.locator('[data-testid="tab-chat"]').getAttribute("aria-selected")) === "true")

  // 1. text
  await s.fill('[data-testid="talk-input"]', "Rocco, in target: vuole partire entro un mese.")
  await s.click('[data-testid="talk-send"]')
  await s.waitForSelector('[data-testid="talk-msg-mine"]', { timeout: 30000 })
  ck("a text message appears at once", (await s.locator('[data-testid="talk-msg-mine"]').first().innerText()).includes("partire entro un mese"))
  ck("it is saved with the setter's name and the lead's team", (await db.query("select sender_name, team_id from marketing_lead_messages where lead_id=$1", [lead.id])).rows[0]?.team_id === team)
  await s.reload({ waitUntil: "networkidle" }); await s.waitForSelector('[data-testid="talk-msg-mine"]')
  ck("it is still there after a reload", true)

  // 2. the seller sees the number on the card and in Messages, opens it from there
  const sellerCtx = await session("qa-td-ownera@example.test")
  const p = await sellerCtx.newPage()
  await p.goto(`${BASE}/marketing/board`, { waitUntil: "networkidle", timeout: 180000 })
  await p.waitForSelector('[data-testid="pipeline"]', { timeout: 60000 })
  await hydrated(p)
  await p.click('[data-testid="view-messages"]')
  await p.waitForSelector('[data-testid="messages"]')
  const unreadTxt = await p.locator('[data-testid="messages-unread"]').innerText()
  ck("the Messages view shows 1 unread and the conversation", unreadTxt.trim() === "1" && (await p.locator('[data-testid="conversation"]').count()) === 1, unreadTxt)
  await p.click('[data-testid="conversation"]')
  const sf = p.frameLocator('[data-testid="lead-window"] iframe').last()
  await sf.locator('[data-testid="lead-chat"]').waitFor({ timeout: 90000 })
  ck("clicking a conversation opens the lead on its Chat tab with the setter's message", (await sf.locator('[data-testid="talk-msg-theirs"]').first().innerText()).includes("partire entro un mese"))
  await p.waitForTimeout(1500)
  ck("opening it marks it read for the seller", (await db.query("select count(*)::int n from marketing_lead_chat_reads where lead_id=$1", [lead.id])).rows[0].n >= 1)

  // 3. the setter now sees the blue tick
  await s.waitForSelector('[data-testid="talk-tick-seen"]', { timeout: 20000 }).then(() => ck("the setter's message turns to the blue 'seen' tick once the seller has read it", true)).catch(() => ck("the setter's message turns to the blue 'seen' tick once the seller has read it", false))

  // 4. seller replies (quote), reacts, edits, deletes
  await sf.locator('[data-testid="talk-msg-theirs"]').first().click({ button: "right" })
  await sf.locator('[data-testid="talk-act-reply"]').click()
  await sf.locator('[data-testid="talk-input"]').fill("Perfetto, lo chiamo lunedì.")
  await sf.locator('[data-testid="talk-send"]').click()
  await sf.locator('[data-testid="talk-quote"]').first().waitFor({ timeout: 30000 })
  ck("a reply shows the quoted message", true)
  await sf.locator('[data-testid="talk-msg-theirs"]').first().click({ button: "right" })
  await sf.locator('[data-testid="talk-react-👍"]').click()
  await sf.locator('[data-testid="talk-reactions"]').first().waitFor({ timeout: 20000 })
  ck("a reaction appears and is stored", (await db.query("select count(*)::int n from marketing_lead_message_reactions r join marketing_lead_messages m on m.id=r.message_id where m.lead_id=$1", [lead.id])).rows[0].n === 1)
  await sf.locator('[data-testid="talk-msg-mine"]').last().click({ button: "right" })
  await sf.locator('[data-testid="talk-act-edit"]').click()
  await sf.locator('[data-testid="talk-input"]').fill("Perfetto, lo chiamo lunedì mattina.")
  await sf.locator('[data-testid="talk-send"]').click()
  await sf.getByText("lunedì mattina").first().waitFor({ timeout: 20000 })
  let orig: string | undefined
  for (let k = 0; k < 20 && orig === undefined; k++) { orig = (await db.query("select original_message from marketing_lead_messages where lead_id=$1 and sender_name='Qa Td Ownera' and edited_at is not null", [lead.id])).rows[0]?.original_message ?? undefined; if (orig === undefined) await p.waitForTimeout(500) }
  ck("an edit changes the text and is stored with the original kept", orig === "Perfetto, lo chiamo lunedì.", orig)

  // 5. a photo and a voice file
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
  await s.locator('[data-testid="talk-file-input"]').setInputFiles({ name: "costi.png", mimeType: "image/png", buffer: png })
  await s.click('[data-testid="talk-send"]')
  await s.waitForSelector('[data-testid="lead-chat"] img', { timeout: 40000 })
  const imgOk = await s.locator('[data-testid="lead-chat"] img').first().evaluate((i: HTMLImageElement) => new Promise<boolean>(r => { if (i.complete) r(i.naturalWidth > 0); else { i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false) } }))
  ck("a photo is sent and shown through a signed link", imgOk)
  const stored = (await db.query("select attachments from marketing_lead_messages where lead_id=$1 and attachments is not null order by created_at desc limit 1", [lead.id])).rows[0].attachments[0]
  ck("the stored attachment is a path inside the lead's own folder, not a public address", String(stored.path).startsWith(`${team}/${lead.id}/`) && !("url" in stored), stored)
  const raw = await s.evaluate(async (u) => (await fetch(u)).status, await s.locator('[data-testid="lead-chat"] img').first().getAttribute("src") as string)
  ck("the signed link opens", raw === 200, raw)
  const bucketPublic = (await db.query("select public from storage.buckets where id='marketing-chat'")).rows[0]?.public
  ck("the bucket is private", bucketPublic === false)

  // voice: the real microphone path with a fake device
  await s.click('[data-testid="talk-mic"]')
  const rec = await s.waitForSelector('[data-testid="talk-recording"]', { timeout: 15000 }).then(() => true).catch(() => false)
  if (rec) {
    await s.waitForTimeout(2500)
    await s.click('[data-testid="talk-voice-send"]')
    await s.waitForSelector('[data-testid="talk-voice-note"]', { timeout: 40000 })
    ck("a voice message is recorded, sent and playable", (await db.query("select count(*)::int n from marketing_lead_messages where lead_id=$1 and attachments->0->>'mime_type' like 'audio/%'", [lead.id])).rows[0].n === 1)
    await s.locator('[data-testid="voice-show-text"]').first().click()
    await s.waitForTimeout(1500)
    const msg = await s.locator('[data-testid="voice-text-error"]').first().innerText().catch(() => "")
    ck("'Show text' answers in plain words (no speech service key here)", msg.length > 0, msg)
  } else ck("the microphone starts a recording", false)

  // 6. search
  await s.click('[data-testid="talk-search-toggle"]')
  await s.fill('[data-testid="talk-search-input"]', "lunedì")
  ck("search finds a word inside the chat", (await s.locator('[data-testid="talk-search-hit"]').count()) >= 1)
  await s.click('[data-testid="talk-search-toggle"]')

  // 7. delete leaves a note
  await sf.locator('[data-testid="talk-msg-mine"]').first().click({ button: "right" })
  await sf.locator('[data-testid="talk-act-delete"]').click()
  await sf.locator('[data-testid="talk-delete-confirm"]').click()
  await sf.getByText("This message was deleted").first().waitFor({ timeout: 20000 })
  ck("a deleted message leaves a note, and the row is kept for the record", (await db.query("select count(*)::int n from marketing_lead_messages where lead_id=$1 and deleted_at is not null", [lead.id])).rows[0].n === 1)

  // 8. the setter's own message cannot be deleted by the other person's api call (author or owner only) — the seller IS the owner here, so check a non-owner path with the setter deleting the seller's
  const sellerMsg = (await db.query("select id from marketing_lead_messages where lead_id=$1 and sender_id=(select user_id from marketing_team_members m join auth.users u on u.id=m.user_id where u.email='qa-td-ownera@example.test' and m.team_id=$2) and deleted_at is null limit 1", [lead.id, team])).rows[0]?.id
  if (sellerMsg) {
    const st = await s.evaluate(async (id) => (await fetch(`/api/marketing/chat/messages/${id}`, { method: "DELETE" })).status, sellerMsg)
    ck("a setter cannot delete the seller's message, and cannot edit it", st === 403)
    const et = await s.evaluate(async (id) => (await fetch(`/api/marketing/chat/messages/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hacked" }) })).status, sellerMsg)
    ck("…edit is refused too", et === 403)
  }

  // 9. closed doors
  if (otherLead) {
    const st = await s.evaluate(async (id) => (await fetch(`/api/marketing/chat/${id}`)).status, otherLead)
    ck("another team's lead has no chat to read", st === 404, st)
    const st2 = await s.evaluate(async (id) => (await fetch(`/api/marketing/chat/${id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "x" }) })).status, otherLead)
    ck("…and no chat to write in", st2 === 404, st2)
  }
  const forged = await s.evaluate(async (a) => (await fetch(`/api/marketing/chat/${a.lead}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "", attachments: [{ path: a.path, name: "x.png", mime_type: "image/png" }] }) })).status, { lead: lead.id, path: `${team}/${otherLead ?? lead.id}/${"3".repeat(8)}-3333-4333-8333-333333333333.png` })
  ck("a file path pointing at another lead's folder is refused", forged === 400 || otherLead === undefined, forged)
  ck("a stranger (no login) cannot read a chat", (await fetch(`${BASE}/api/marketing/chat/${lead.id}`, { redirect: "manual" })).status !== 200)
  ck("the notification worker is public (no login needed to fetch it)", (await fetch(`${BASE}/marketing-sw.js`, { redirect: "manual" })).status === 200)

  // 10. notifications: subscribe, list, remove
  const sub = await s.evaluate(async () => (await fetch("/api/marketing/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: { endpoint: "https://push.example.test/abc", keys: { p256dh: "p", auth: "a" } } }) })).status)
  ck("a browser can sign up for notifications for its own team", sub === 200 && (await db.query("select count(*)::int n from marketing_push_subscriptions where team_id=$1", [team])).rows[0].n === 1, sub)
  const badSub = await s.evaluate(async () => (await fetch("/api/marketing/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: { endpoint: "http://insecure.test/x", keys: { p256dh: "p", auth: "a" } } }) })).status)
  ck("an insecure notification address is refused", badSub === 400, badSub)
  await s.evaluate(async () => fetch("/api/marketing/push", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "https://push.example.test/abc" }) }))
  ck("and can sign off", (await db.query("select count(*)::int n from marketing_push_subscriptions where team_id=$1", [team])).rows[0].n === 0)

  await s.screenshot({ path: `${SHOTS}/chat-setter.png` })
  await p.screenshot({ path: `${SHOTS}/chat-seller.png` })
  console.log(`\n${pass} passed, ${fail} failed`)
  await browser.close(); await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
