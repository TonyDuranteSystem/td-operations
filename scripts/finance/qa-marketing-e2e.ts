/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa; Antonio 2026-10-28): END TO END through the REAL doors. Seeds real-shaped Stripe payments from Rocco's links, then calls the
   REAL cron address (the one Vercel calls every 3 minutes) over HTTP — twice in parallel too — and proves: the money is matched in Finance, the card moves only then, the invoice, the
   credit and the email are made ONCE (captured, Italian/English), a wrong amount pays nothing, an unlabelled look-alike is untouched, a hand-recorded sale is settled; and in a REAL
   browser, as the real logins: Antonio sees the row as Matched in Finance → Bank Feed, and Rocco's board shows the card in Paid.
   Needs: private stack up (+ incoming_payment_resolutions migrations), `td-marketing-dev` on :3010. Run: npx tsx scripts/finance/qa-marketing-e2e.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { chromium, type BrowserContext } from "playwright"
import { Client } from "pg"
import { SignJWT } from "jose"
import { execSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const BASE = process.env.QA_BASE ?? "http://127.0.0.1:3010"
const SHOTS = process.env.QA_SHOTS ?? "/tmp"
const PASS = "Qa-ws-pass-12345"
const tag = `qfe${Date.now()}`
let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  type AuthAdmin = { auth: { admin: { createUser: (a: object) => Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }> } } }
  const A = (supabaseAdmin as unknown as AuthAdmin).auth.admin
  const M = await import("@/lib/marketing/members")
  const S = await import("@/lib/marketing/settings")

  // ---- the team, a seller-owner (Rocco's kind of login) and Antonio (admin)
  const team = (await S.createTeam({ name: `QA fe ${tag}`, actor: "qa-fe" })).data!
  await S.setTeamStatus(team.id, "active", "qa-fe")
  const adminActor = { kind: "admin" as const, userId: null, label: "qa-fe", permissions: [] as string[] }
  const rocco = `${tag}-rocco@example.test`
  const inv = await M.createInvite({ teamId: team.id, email: rocco, memberRole: "owner", bundle: null, actor: adminActor })
  if (inv.ok === false) throw new Error(`invite: ${inv.error}`)
  const acc = await M.acceptInvite({ token: new URL(inv.data!.inviteUrl).searchParams.get("token") ?? "", password: PASS })
  if (acc.ok === false) throw new Error(`accept: ${acc.error}`)
  const roccoId = (await db.query("select id from auth.users where email=$1", [rocco])).rows[0].id as string
  const adminEmail = `${tag}-antonio@example.test`
  const ar = await A.createUser({ email: adminEmail, password: PASS, email_confirm: true, app_metadata: { role: "admin" }, user_metadata: { full_name: "Qa Antonio" } })
  if (ar.error || !ar.data.user) throw new Error(`admin: ${ar.error?.message}`)
  const adminId = ar.data.user.id
  for (const uid of [roccoId, adminId]) await db.query(`insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values (gen_random_uuid(), $1, 'qa', 'totp', 'verified', now(), now(), 'x')`, [uid])
  for (const k of ["setter", "seller", "content", "analyst", "owner"]) await db.query("insert into marketing_tour_seen (user_id, team_id, tour_key, status) values ($1,$2,$3,'done') on conflict do nothing", [roccoId, team.id, k])
  const stages = (await db.query("select value from marketing_settings where team_id=$1 and key='sale_kind_stages'", [team.id])).rows[0]?.value
  const paidStage: string = stages?.strategic_call ?? "paid_call"

  // ---- real-shaped payments
  async function seed(k: string, o: { campaign?: string; feedAmount?: number; labelled?: boolean; handRecorded?: boolean; email?: string; daysOld?: number } = {}) {
    const email = o.email ?? `${tag}-${k}@qa-mail.dev`
    const lead = (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, campaign_name, received_at, claimed_by, claimed_by_label, answers) values ($1,$2,$3,$4,'+393339990000','closed',$5, now(), $6, $7, '[]'::jsonb) returning id", [team.id, `${tag}-${k}`, `Lead ${k} ${tag}`, email, o.campaign ?? "14.10.2026 | LLC ITA | Lead Form", roccoId, rocco])).rows[0].id
    const session = `cs_live_${tag}${k}`, pi = `pi_${tag}${k}`, saleId = randomUUID()
    await db.query("insert into marketing_sales (id, team_id, lead_id, kind, amount_cents, currency, status, created_by, stripe_session_id) values ($1,$2,$3,'strategic_call',39700,'EUR','link_created',$4,$5)", [saleId, team.id, lead, rocco, session])
    const labelled = o.labelled !== false
    const charge = { id: `ch_${tag}${k}`, metadata: {}, status: "succeeded", payment_intent: { id: pi, metadata: labelled ? { source: "td-marketing", payment_kind: "marketing_sale", marketing_lead_id: lead, marketing_sale_id: saleId, marketing_team_id: team.id } : {}, payment_details: { order_reference: session } } }
    const feed = (await db.query("insert into td_bank_feeds (source, external_id, transaction_date, amount, currency, sender_name, memo, status, raw_data) values ('stripe',$1, now() - ($6 || ' days')::interval,$2,'EUR',$3,$4,'unmatched',$5) returning id", [charge.id, o.feedAmount ?? 397, `Card ${k}`, `email: ${email}`, JSON.stringify(charge), String(o.daysOld ?? 0)])).rows[0].id
    if (o.handRecorded) {
      await db.query("update marketing_sales set status='paid', paid_at=now(), stripe_payment_intent=$2, note='Recorded afterwards by qa: hand-made link.' where id=$1", [saleId, pi])
      await db.query("update marketing_leads set status=$2 where id=$1", [lead, paidStage])
      await db.query("insert into incoming_payment_resolutions (stripe_session_id, resolution, note, resolved_by) values ($1,'marketing_sale',$2,'qa')", [session, `Marketing lead ${lead}, sale ${saleId}.`])
    }
    return { k, email, lead, saleId, feed, session, pi }
  }
  type Seed = Awaited<ReturnType<typeof seed>>
  const st = async (s: Seed) => ({
    sale: (await db.query("select status, paid_at from marketing_sales where id=$1", [s.saleId])).rows[0],
    lead: (await db.query("select status from marketing_leads where id=$1", [s.lead])).rows[0].status as string,
    feed: (await db.query("select status, matched_payment_id from td_bank_feeds where id=$1", [s.feed])).rows[0],
    invoices: (await db.query("select count(*)::int n from payments where stripe_payment_id=$1 and invoice_status='Paid'", [s.pi])).rows[0].n as number,
    mails: (await db.query("select subject from sandbox_captured_emails where recipient=$1", [s.email])).rows as Array<{ subject: string }>,
  })
  const tick = async () => {
    const r = await fetch(`${BASE}/api/cron/stripe-sync?days=3`, { headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {} })
    return { status: r.status, body: (await r.json().catch(() => ({}))) as { marketing?: { waiting: number; matched: number; failed: number; handRecorded: { matched: number } }; error?: string } }
  }

  const a = await seed("a")                                              // the normal case (Italian ad)
  const en = await seed("en", { campaign: "LLC US | Lead Form" })        // English ad
  const b = await seed("b", { feedAmount: 297 })                         // wrong amount
  const c = await seed("c", { labelled: false, handRecorded: true })     // recorded by hand afterwards (Monica's kind)
  const x = await seed("x", { labelled: false })                         // a look-alike: same amount, NO label, no sale paid, nobody recorded it
  const par = await seed("par")                                          // two ticks at the very same moment
  const old = await seed("old", { daysOld: 10 })                         // a payment from 10 days ago: automation leaves it alone
  const tst = await seed("tst", { email: `qa-${tag}@example.test` })     // a test lead

  const preA = await st(a)
  ck("E1 before the 3-minute tick: the sale is open, the card has not moved, the row is unmatched, nothing was emailed", preA.sale.status === "link_created" && preA.lead === "closed" && preA.feed.status === "unmatched" && preA.mails.length === 0, preA)

  // ---- the real cron address, once; and twice in parallel for `par`
  const t1 = await tick()
  ck("E2 the real cron address answers 200 and reports the marketing payments it found", t1.status === 200 && (t1.body.marketing?.waiting ?? 0) >= 4, t1)
  const [pa, pb] = await Promise.all([tick(), tick()])
  ck("E2b two ticks at the same moment both answer 200", pa.status === 200 && pb.status === 200, { pa, pb })

  const sa = await st(a), sen = await st(en), sb = await st(b), sc = await st(c), sx = await st(x), spar = await st(par)
  ck("E3 normal case: matched in Finance, sale PAID, card moved to the paid stage, ONE invoice, ONE email in Italian", sa.feed.status === "matched" && sa.sale.status === "paid" && sa.lead === paidStage && sa.invoices === 1 && sa.mails.length === 1 && /Pagamento ricevuto/.test(sa.mails[0].subject), sa)
  ck("E4 English ad: ONE email in English", sen.invoices === 1 && sen.mails.length === 1 && /Payment received/.test(sen.mails[0].subject) && sen.lead === paidStage, sen)
  ck("E5 wrong amount: parked for review, the sale stays unpaid, the card stays, NO invoice, NO email", sb.feed.status === "needs_review" && sb.sale.status === "link_created" && sb.lead === "closed" && sb.invoices === 0 && sb.mails.length === 0, sb)
  ck("E6 hand-recorded sale (no labels): settled by its Stripe id — matched, ONE invoice, ONE email", sc.feed.status === "matched" && sc.invoices === 1 && sc.mails.length === 1, sc)
  ck("E7 an unlabelled look-alike (same amount, nobody recorded it): untouched — still unmatched, no invoice, no email", sx.feed.status === "unmatched" && sx.invoices === 0 && sx.mails.length === 0 && sx.sale.status === "link_created", sx)
  ck("E8 two ticks at the same moment: still exactly ONE invoice, ONE credit, ONE email", spar.invoices === 1 && spar.mails.length === 1 && spar.feed.status === "matched", spar)
  const sold = await st(old), stst = await st(tst)
  ck("E8c a payment from 10 days ago is left alone by the 3-minute tick: no invoice, no email, the card stays", sold.feed.status === "unmatched" && sold.invoices === 0 && sold.mails.length === 0 && sold.lead === "closed", sold)
  ck("E8d a test lead is parked: no invoice, no email", stst.feed.status === "needs_review" && stst.invoices === 0 && (await db.query("select count(*)::int n from sandbox_captured_emails where recipient=$1", [`qa-${tag}@example.test`])).rows[0].n === 0, stst)
  const credits = (await db.query("select count(*)::int n from payments p where p.invoice_status='Credit' and p.contact_id=(select contact_id from payments where stripe_payment_id=$1 and invoice_status='Paid')", [par.pi])).rows[0].n
  ck("E8b …and exactly ONE credit for the person", credits === 1, credits)

  // ---- the next ticks change nothing
  const t3 = await tick()
  const again = await st(a)
  ck("E9 the next 3-minute tick: nothing new for any of them (same invoice, same email count)", t3.status === 200 && again.invoices === 1 && again.mails.length === 1 && (await st(par)).mails.length === 1 && (await st(c)).mails.length === 1, again)

  // ---- real browser, real logins
  const jwtSecret = (() => {
    const cn = execSync("docker ps --format '{{.Names}}'").toString().split("\n").find(n => n.startsWith("supabase_auth_tdlocal-claude-circlback"))
    const env = execSync(`docker inspect ${cn} --format '{{range .Config.Env}}{{println .}}{{end}}'`).toString()
    return env.split("\n").find(l => l.startsWith("GOTRUE_JWT_SECRET="))!.slice("GOTRUE_JWT_SECRET=".length)
  })()
  const browser = await chromium.launch()
  async function session(email: string): Promise<BrowserContext> {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/login`, { waitUntil: "load", timeout: 180000 })
    await page.waitForTimeout(4000)
    await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', PASS); await page.click('button[type="submit"]')
    const until = Date.now() + 120000
    for (;;) { if ((await ctx.cookies(BASE)).some(k => /^sb-.*-auth-token/.test(k.name)) || Date.now() > until) break; await page.waitForTimeout(500) }
    await page.waitForTimeout(1500)
    const parts = (await ctx.cookies(BASE)).filter(k => /^sb-.*-auth-token(\.\d+)?$/.test(k.name)).sort((x1, y) => x1.name.localeCompare(y.name))
    const base = parts[0].name.replace(/\.\d+$/, "")
    let raw = parts.map(k => decodeURIComponent(k.value)).join("")
    raw = raw.startsWith("base64-") ? Buffer.from(raw.slice(7), "base64url").toString("utf8") : raw
    const sess = JSON.parse(raw)
    const claims = JSON.parse(Buffer.from(sess.access_token.split(".")[1], "base64url").toString("utf8"))
    claims.aal = "aal2"; claims.amr = [{ method: "totp", timestamp: Math.floor(Date.now() / 1000) }, ...(claims.amr ?? [])]
    sess.access_token = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(new TextEncoder().encode(jwtSecret))
    await db.query("update auth.sessions set aal='aal2' where id=$1", [claims.session_id])
    await ctx.clearCookies()
    await ctx.addCookies([{ name: base, value: "base64-" + Buffer.from(JSON.stringify(sess), "utf8").toString("base64url"), domain: new URL(BASE).hostname, path: "/", httpOnly: false, secure: false, sameSite: "Lax" }])
    await ctx.addCookies([{ name: "tdm_lang", value: "en", domain: new URL(BASE).hostname, path: "/" }])
    await page.close()
    return ctx
  }
  const open = async (ctx: BrowserContext, path: string) => { const p = await ctx.newPage(); await p.goto(BASE + path, { waitUntil: "commit", timeout: 240000 }); await p.waitForLoadState("load", { timeout: 120000 }).catch(() => undefined); await p.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => undefined); await p.waitForTimeout(2500); return p }

  const antonio = await session(adminEmail)
  const fp = await open(antonio, "/finance?tab=bank")
  const body = async (p: Awaited<ReturnType<typeof open>>) => (await p.locator("body").innerText()).replace(/\s+/g, " ")
  // the filter tabs of the Bank Feed: Matched / Unmatched / Needs review
  const clickTab = async (name: RegExp) => { const t = fp.getByRole("button", { name }).first(); if (await t.count()) { await t.click(); await fp.waitForTimeout(2500) } }
  await clickTab(/^Matched/i)
  const matchedText = await body(fp)
  ck("E10 in Finance → Bank Feed (Matched) Antonio sees the payments of the normal and the hand-recorded cases as matched", /Card a/.test(matchedText) && /Card c/.test(matchedText), matchedText.slice(0, 400))
  await fp.screenshot({ path: `${SHOTS}/qa-fe-bank-matched.png`, fullPage: false })
  await clickTab(/^Unmatched/i)
  const unText = await body(fp)
  ck("E11 …and in Unmatched the look-alike and the old payment are left (the matched ones are gone from the to-do list)", /Card x/.test(unText) && !/Card a\b/.test(unText) && !/Card c\b/.test(unText), unText.slice(0, 400))
  await fp.screenshot({ path: `${SHOTS}/qa-fe-bank-unmatched.png`, fullPage: false })
  await clickTab(/Needs review/i)
  const nrText = await body(fp)
  ck("E12 …and the wrong-amount payment waits under Needs review", /Card b/.test(nrText), nrText.slice(0, 400))
  await fp.screenshot({ path: `${SHOTS}/qa-fe-bank-review.png`, fullPage: false })

  const roccoCtx = await session(rocco)
  const bp = await open(roccoCtx, "/marketing/board")
  const boardText = await body(bp)
  ck("E13 on Rocco's board the paid leads are on the board (Paid), the wrong-amount lead is still where it was", /Lead a /.test(boardText) && /Lead en /.test(boardText), boardText.slice(0, 300))
  await bp.screenshot({ path: `${SHOTS}/qa-fe-board.png`, fullPage: false })
  const ev = (await db.query("select kind, actor from marketing_lead_events where lead_id=$1 order by created_at", [a.lead])).rows
  ck("E14 the paid lead's history says the payment was received, and the card moved to Paid", ev.some((e: { kind: string }) => e.kind === "payment_received") && (await db.query("select status from marketing_leads where id=$1", [a.lead])).rows[0].status === paidStage, ev)
  await browser.close()

  console.log(`\n${pass} passed, ${fail} failed`)
  // clean this run (local test database only, exact tag)
  await db.query("set session_replication_role = replica")
  const contacts = (await db.query("select id from contacts where email like $1", [`${tag}-%`])).rows.map(r => r.id)
  await db.query("delete from payment_items where payment_id in (select id from payments where contact_id = any($1))", [contacts])
  await db.query("delete from payments where contact_id = any($1)", [contacts])
  await db.query("delete from contacts where id = any($1)", [contacts])
  await db.query("delete from sandbox_captured_emails where recipient like $1", [`${tag}-%`])
  await db.query("delete from incoming_payment_resolutions where stripe_session_id like $1", [`cs_live_${tag}%`])
  const leadIds = (await db.query("select id from marketing_leads where leadgen_id like $1", [`${tag}-%`])).rows.map(r => r.id)
  await db.query("delete from marketing_lead_events where lead_id = any($1)", [leadIds])
  await db.query("delete from marketing_sales where lead_id = any($1)", [leadIds])
  await db.query("delete from td_bank_feeds where external_id like $1", [`ch_${tag}%`])
  await db.query("delete from marketing_leads where id = any($1)", [leadIds])
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
