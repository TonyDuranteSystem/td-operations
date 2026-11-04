/* eslint-disable no-console */
/* SANDBOX + a local dev server (TD Marketing, dev job 9aec66fa, Release 1 of the 3 Nov 2026 hand-over). Through the REAL login page and the REAL database it proves: the setter's board has no "Interested lead";
   booking the free call makes the lead the seller's at once (pick set, leaves her board, appears under "Calls prenotate"); cancelling takes it back; the old leftovers show under "After the call"; and the seller
   sees the old past calls first, with a red "Call time passed" tag, in the one column Calls prenotate. Needs the seed (`qa-handover-r1-seed.ts`) and the one-off applied on its team, and `PORT=3060 npm run dev`.
   Run: npx tsx scripts/marketing/qa-handover-r1.ts   (screenshots go to $QA_SHOTS or /tmp) */
import { config } from "dotenv"
config({ path: ".env.local" })
import fs from "node:fs"
import crypto from "node:crypto"
import { chromium, type BrowserContext, type Page } from "playwright"
import { Client } from "pg"

const BASE = process.env.QA_BASE ?? "http://localhost:3060"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const S = JSON.parse(fs.readFileSync("/tmp/r1qa-handover.json", "utf8")) as { password: string; teamId: string; seller: string; setter: string; sellerId: string; leads: Record<string, string> }
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
/** The 6-digit code of an authenticator app (RFC 6238, SHA-1, 30 s) for a base32 secret: the QA people are throw-away test accounts, so their second step is done by the script. */
function totp(secretB32: string, at = Date.now()): string {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const ch of secretB32.replace(/=+$/, "").toUpperCase().replace(/\s/g, "")) bits += alpha.indexOf(ch).toString(2).padStart(5, "0")
  const key = Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)))
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)))
  const h = crypto.createHmac("sha1", key).update(counter).digest()
  const o = h[h.length - 1] & 0xf
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0")
}
const TOTP_FILE = "/tmp/r1qa-totp.json"
const secrets = (): Record<string, string> => { try { return JSON.parse(fs.readFileSync(TOTP_FILE, "utf8")) } catch { return {} } }
const L = (name: string) => S.leads[`R1QA ${name}`]

async function main() {
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
  await db.connect()
  const lead = async (id: string) => (await db.query("select status, claimed_by from marketing_leads where id=$1", [id])).rows[0] as { status: string; claimed_by: string | null }
  const browser = await chromium.launch()
  async function login(email: string): Promise<BrowserContext> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 240000 })
    await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', S.password); await page.click('button[type="submit"]')
    await page.waitForURL(u => !u.pathname.startsWith("/login"), { timeout: 180000 })
    // the second step (marketing logins always have one): enrol the first time, then answer it with the saved secret
    if (page.url().includes("/mfa/enroll")) {
      await page.getByRole("button", { name: "Start setup" }).click()
      const secretEl = page.locator("button.font-mono").first()
      await secretEl.waitFor({ timeout: 60000 })
      const secret = (await secretEl.innerText()).trim()
      fs.writeFileSync(TOTP_FILE, JSON.stringify({ ...secrets(), [email]: secret }), { mode: 0o600 })
      await page.getByPlaceholder("••••••").fill(totp(secret))
      await page.getByRole("button", { name: "Activate" }).click()
      await page.getByText("Save your backup codes").waitFor({ timeout: 60000 })
    } else if (page.url().includes("/mfa/verify")) {
      const secret = secrets()[email]
      if (!secret) throw new Error(`no saved second-step secret for ${email}`)
      await page.locator("input").first().fill(totp(secret))
      await page.keyboard.press("Enter")
      await page.waitForURL(u => !u.pathname.startsWith("/mfa"), { timeout: 60000 })
    }
    await page.waitForTimeout(1500); await page.close()
    return ctx
  }
  const open = async (ctx: BrowserContext, path: string): Promise<Page> => { const p = await ctx.newPage(); await p.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 240000 }); await p.waitForTimeout(1500); return p }
  const text = async (p: Page) => (await p.locator("body").innerText()).replace(/\s+/g, " ")
  const colText = async (p: Page, ...heads: string[]) => { const cond = heads.map(h => `starts-with(normalize-space(text()), "${h} ·")`).join(" or "); const col = p.locator(`xpath=//*[self::section or self::div][.//*[${cond}]]`).last(); return (await col.innerText().catch(() => "")).replace(/\s+/g, " ") }
  const when = (days: number) => { const d = new Date(Date.now() + days * 86400_000); d.setHours(15, 0, 0, 0); const z = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T15:00` }

  // ---------- the setter
  const setter = await login(S.setter)
  let p = await open(setter, "/marketing/board")
  await p.screenshot({ path: `${SHOTS}/r1-setter-board-before.png`, fullPage: true })
  let t = await text(p)
  ck("setter board: no 'Interested lead' column", !/Interested lead ·|Lead interessato ·/.test(t), t.slice(0, 300))
  ck("setter board: In target holds the two in-target leads", /In target · 2/.test(t), t.slice(0, 400))
  ck("setter board: the old booked leads are not on her board", !/Old booked future/.test(t) && !/Old booked past/.test(t))
  await p.close()

  // booking the free call for the seller
  p = await open(setter, `/marketing/window/${L("Qualified A (setter will book)")}`)
  ck("setter window: the box says to book Rocco's call (English or Italian); no Pass to Rocco button", /Book Rocco's call|Fissa la chiamata con Rocco/.test(await text(p)) && (await p.getByTestId("handover-pass").count()) === 0, (await text(p)).slice(0, 300))
  await p.getByTestId("handover-book").click()
  await p.waitForSelector('[data-testid="appointment-when"]', { timeout: 60000 })
  await p.fill('[data-testid="appointment-when"]', when(2))
  await p.locator(`[data-testid="typed-form"] textarea`).fill("R1QA note for Rocco: wants the costs")
  await p.getByTestId("book-confirm").click()
  await p.waitForSelector('[data-testid="call-booked"]', { timeout: 60000 })
  await p.screenshot({ path: `${SHOTS}/r1-setter-after-booking.png`, fullPage: true })
  const a = await lead(L("Qualified A (setter will book)"))
  ck("booking: the lead is now booked AND with the seller", a.status === "booked" && a.claimed_by === S.sellerId, a)
  await p.close()

  p = await open(setter, "/marketing/board")
  t = await text(p)
  ck("setter board after booking: the booked lead left her board; one in-target lead stays", !/Qualified A/.test(t) && /In target · 1/.test(t), t.slice(0, 400))
  await p.screenshot({ path: `${SHOTS}/r1-setter-board-after.png`, fullPage: true })
  await p.close()

  // book then cancel: it goes back to her and is unpicked
  p = await open(setter, `/marketing/window/${L("Qualified B (booking then cancel)")}`)
  await p.getByTestId("handover-book").click()
  await p.waitForSelector('[data-testid="appointment-when"]', { timeout: 60000 })
  await p.fill('[data-testid="appointment-when"]', when(3))
  await p.getByTestId("book-confirm").click()
  await p.waitForSelector('[data-testid="call-booked"]', { timeout: 60000 })
  ck("book B: booked and picked", (await lead(L("Qualified B (booking then cancel)"))).claimed_by === S.sellerId)
  await p.getByTestId("call-cancel").click()
  await p.waitForTimeout(3000)
  const b = await lead(L("Qualified B (booking then cancel)"))
  ck("cancel B: back in target and unpicked", b.status === "qualified" && b.claimed_by === null, b)
  await p.close()

  // ---------- the seller
  const seller = await login(S.seller)
  p = await open(seller, "/marketing/board")
  await p.screenshot({ path: `${SHOTS}/r1-seller-board.png`, fullPage: true })
  const calls = await colText(p, "Calls prenotate")
  ck("seller board: Calls prenotate holds the new booking, the old future call, the old past call and the old Contacted lead", /Qualified A/.test(calls) && /Old booked future/.test(calls) && /Old booked past/.test(calls) && /Old seller contacted/.test(calls), calls.slice(0, 400))
  ck("seller board: the past calls are tagged 'Call time passed' and come before the future one", (await p.getByTestId("card-call-passed").count()) === 2 && calls.indexOf("Old booked past") < calls.indexOf("Old booked future"), calls.slice(0, 400))
  ck("seller board: there is no After the call column", !/After the call ·|Dopo la call ·/.test(await text(p)))
  t = await text(p)
  ck("seller board: no Interested lead and no Contacted column", !/Interested lead ·|Lead interessato ·/.test(t) && !/Contacted ·|Contattato ·/.test(t), t.slice(0, 300))
  await p.close()

  p = await open(seller, `/marketing/window/${L("Qualified A (setter will book)")}`)
  t = await text(p)
  ck("seller window on the new booking: picked by you, the setter's note sits in the call box, no Pick button", /With:\s*you|Con:\s*te/.test(t) && await p.getByTestId("handover-note").count() === 1 && /wants the costs/.test(await p.getByTestId("handover-note").innerText()) && !/Pick this lead|Prendi questo lead/.test(t), t.slice(0, 500))
  await p.screenshot({ path: `${SHOTS}/r1-seller-window-new.png`, fullPage: true })
  await p.close()

  p = await open(seller, `/marketing/window/${L("Old booked past")}`)
  ck("seller window on an old past call: says the call time has passed, no yes/no question", await p.getByTestId("call-passed").count() === 1 && await p.getByTestId("call-check").count() === 0)
  await p.screenshot({ path: `${SHOTS}/r1-seller-call-passed.png`, fullPage: true })
  await p.close()

  console.log(`\n${pass} passed, ${fail} failed`)
  await browser.close(); await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
