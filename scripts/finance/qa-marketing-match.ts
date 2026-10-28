/* eslint-disable no-console */
/* LOCAL private stack only (TD Marketing, dev job 9aec66fa; Antonio 2026-10-28: Finance regulates): runs the REAL Finance step on seeded rows and proves
   a payment from Rocco's link is matched to its sale and lead; the card moves only then; the invoice + credit are made once; the invoice email is captured once
   (in Italian for an Italian ad); a second run changes nothing; a wrong amount is parked and pays nothing.
   Needs: the private stack up with the incoming_payment_resolutions migrations applied. Run: npx tsx scripts/finance/qa-marketing-match.ts */
import { config } from "dotenv"
config({ path: ".env.local" })
import { Client } from "pg"
import { randomUUID } from "node:crypto"

let pass = 0, fail = 0
const ck = (id: string, ok: boolean, note?: unknown) => { if (ok) pass++; else fail++; console.log(ok ? "PASS" : "FAIL", id, ok ? "" : JSON.stringify(note)) }
const tag = `qfm${Date.now()}`

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("127.0.0.1")) throw new Error("local private stack only")
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false })
  await db.connect()
  const { settleMarketingSaleFromFeed, settleHandRecordedSales } = await import("@/lib/finance/marketing-sale-settle")
  const { matchAndReconcile } = await import("@/lib/bank-feed-matcher")

  const team = (await db.query("insert into marketing_teams (name) values ($1) returning id", [`QA fm ${tag}`])).rows[0].id
  await db.query("insert into marketing_settings (team_id, key, value) values ($1,'sale_kind_stages','{\"strategic_call\":\"paid_call\"}'::jsonb) on conflict do nothing", [team]).catch(() => undefined)
  const stages = (await db.query("select value from marketing_settings where team_id=$1 and key='sale_kind_stages'", [team])).rows[0]?.value
  const paidStage = stages?.strategic_call ?? "paid_call"

  async function scenario(k: string, opts: { amountCents?: number; feedAmount?: number; email?: string; campaign?: string; refunded?: boolean } = {}) {
    const email = opts.email ?? `${tag}-${k}@example.test`
    const lead = (await db.query("insert into marketing_leads (team_id, leadgen_id, full_name, email, phone, status, campaign_name, received_at, answers) values ($1,$2,$3,$4,'+393339990000','link_sent',$5, now(), '[]'::jsonb) returning id", [team, `${tag}-${k}`, `QA ${k} Lead`, email, opts.campaign ?? "14.10.2026 | LLC ITA | Lead Form"])).rows[0].id
    const session = `cs_live_${tag}${k}`
    const pi = `pi_${tag}${k}`
    const saleId = randomUUID()
    await db.query("insert into marketing_sales (id, team_id, lead_id, kind, amount_cents, currency, status, created_by, stripe_session_id) values ($1,$2,$3,'strategic_call',$4,'EUR','link_created','qa',$5)", [saleId, team, lead, opts.amountCents ?? 39700, session])
    const charge = { id: `ch_${tag}${k}`, metadata: {}, status: "succeeded", payment_intent: { id: pi, metadata: { source: "td-marketing", payment_kind: "marketing_sale", marketing_lead_id: lead, marketing_sale_id: saleId, marketing_team_id: team }, payment_details: { order_reference: session } } }
    const feed = (await db.query("insert into td_bank_feeds (source, external_id, transaction_date, amount, currency, sender_name, status, raw_data) values ('stripe',$1,now(),$2,'EUR',$3,'unmatched',$4) returning id", [charge.id, opts.feedAmount ?? 397, `QA ${k}`, JSON.stringify(charge)])).rows[0].id
    return { lead, saleId, feed, email, session, pi }
  }
  const state = async (s: { lead: string; saleId: string; feed: string }) => ({
    sale: (await db.query("select status, paid_at, stripe_payment_intent, needs_attention from marketing_sales where id=$1", [s.saleId])).rows[0],
    lead: (await db.query("select status from marketing_leads where id=$1", [s.lead])).rows[0],
    feed: (await db.query("select status, matched_payment_id, match_confidence, review_metadata from td_bank_feeds where id=$1", [s.feed])).rows[0],
  })

  // ---- 1. the normal case, through the REAL matcher entry (the one the cron uses)
  const a = await scenario("a")
  const before = await state(a)
  ck("F1 before Finance matches: the sale is open, the card has not moved, the row is unmatched", before.sale.status === "link_created" && before.lead.status === "link_sent" && before.feed.status === "unmatched", before)
  const r1 = await matchAndReconcile(a.feed)
  const after = await state(a)
  ck("F2 Finance matches the payment: matched=true", r1.matched === true && !!r1.paymentId && !!r1.invoiceNumber, r1)
  ck("F3 …the sale is now PAID at the payment's own time and the card moved to the paid stage", after.sale.status === "paid" && after.sale.stripe_payment_intent === a.pi && after.lead.status === paidStage, after)
  ck("F4 …the Bank Feed row is MATCHED to the invoice, not ignored", after.feed.status === "matched" && after.feed.matched_payment_id === r1.paymentId, after.feed)
  const inv = (await db.query("select id, invoice_number, invoice_status, total, amount_currency, stripe_payment_id, contact_id from payments where id=$1", [r1.paymentId])).rows[0]
  ck("F5 …a PAID 'Strategic Call' invoice of 397 EUR exists, stamped with the Stripe payment", inv && inv.invoice_status === "Paid" && Number(inv.total) === 397 && inv.amount_currency === "EUR" && inv.stripe_payment_id === a.pi, inv)
  const credit = (await db.query("select invoice_number, invoice_status, credit_remaining from payments where contact_id=$1 and invoice_status='Credit'", [inv.contact_id])).rows
  ck("F6 …and ONE deductible credit of 397 for the person", credit.length === 1 && Number(credit[0].credit_remaining) === 397 && /^CN-/.test(credit[0].invoice_number), credit)
  const mail = (await db.query("select recipient, subject, body from sandbox_captured_emails where recipient=$1 order by created_at desc", [a.email]).catch(() => ({ rows: [] as Array<Record<string, string>> }))).rows
  ck("F7 …the invoice is emailed to the lead ONCE, in Italian (Italian ad)", mail.length === 1 && /Pagamento ricevuto/.test(mail[0].subject ?? "") && /Gentile QA a Lead/.test(mail[0].body ?? ""), mail)

  // ---- 2. a second run (cron overlap, retry) changes nothing and sends nothing
  const again = await settleMarketingSaleFromFeed(a.feed)
  const twice = await matchAndReconcile(a.feed)
  const nInv = (await db.query("select count(*)::int n from payments where contact_id=$1 and invoice_status='Paid'", [inv.contact_id])).rows[0].n
  const nCr = (await db.query("select count(*)::int n from payments where contact_id=$1 and invoice_status='Credit'", [inv.contact_id])).rows[0].n
  const mail2 = (await db.query("select count(*)::int n from sandbox_captured_emails where recipient=$1", [a.email]).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n
  ck("F8 a second run: already matched, no second invoice, no second credit, no second email", (again.matched && again.alreadyMatched === true) && twice.matched === true && nInv === 1 && nCr === 1 && mail2 === 1, { again, twice, nInv, nCr, mail2 })

  // ---- 3. a retry after the invoice was made but before the row was marked (a crash in between): still ONE invoice, ONE credit
  const c = await scenario("c")
  await settleMarketingSaleFromFeed(c.feed, { sendEmail: false })
  await db.query("update td_bank_feeds set status='unmatched', matched_payment_id=null, matched_at=null where id=$1", [c.feed])
  const rr = await settleMarketingSaleFromFeed(c.feed, { sendEmail: false })
  const ci = (await db.query("select count(*)::int n from payments where contact_id=(select contact_id from payments where id=$1) and invoice_status='Paid'", [rr.matched ? rr.paymentId : null])).rows[0].n
  ck("F9 a retry after a crash in the middle makes no second invoice", rr.matched === true && ci === 1, { rr, ci })

  // ---- 4. the money does not match the link: parked for a person, nothing paid, no invoice, no email
  const b = await scenario("b", { feedAmount: 297 })
  const rb = await matchAndReconcile(b.feed)
  const sb = await state(b)
  const nb = (await db.query("select count(*)::int n from payments where stripe_payment_id=$1", [b.pi])).rows[0].n
  ck("F10 a wrong amount is parked for review: the sale stays unpaid, the card stays, no invoice", rb.matched === false && sb.feed.status === "needs_review" && sb.sale.status === "link_created" && sb.lead.status === "link_sent" && nb === 0, { rb, sb, nb })
  ck("F10b …and the row says why, in plain words", /not the amount of the link/.test(String(sb.feed.review_metadata?.marketing_sale_problem)), sb.feed.review_metadata)

  // ---- 5. a payment with the right amount but NO label is never taken for a marketing sale
  const d = await scenario("d")
  await db.query("update td_bank_feeds set raw_data=jsonb_set(raw_data,'{payment_intent,metadata}','{}'::jsonb) where id=$1", [d.feed])
  const rd = await settleMarketingSaleFromFeed(d.feed)
  ck("F11 no label: not a marketing payment, nothing touched", rd.matched === false && (rd as { notMarketing?: boolean }).notMarketing === true && (await state(d)).sale.status === "link_created")

  // ---- 6. English ad -> English email
  const e = await scenario("e", { campaign: "LLC US | Lead Form" })
  await matchAndReconcile(e.feed)
  const me = (await db.query("select subject from sandbox_captured_emails where recipient=$1", [e.email]).catch(() => ({ rows: [] as Array<{ subject: string }> }))).rows
  ck("F12 a lead from a non-Italian ad gets the English receipt", me.length === 1 && /Payment received/.test(me[0].subject), me)

  // ---- 7. a sale recorded BY HAND afterwards (hand-made link, no labels, an older "ignored" tag, a confirmation row already there)
  const h = await scenario("h", { email: `${tag}-h@example.test` })
  await db.query("update td_bank_feeds set raw_data=jsonb_set(raw_data,'{payment_intent,metadata}','{}'::jsonb), status='ignored', review_metadata='{\"marketing_sale\":{\"tagged_by\":\"qa\"}}'::jsonb where id=$1", [h.feed])
  await db.query("update marketing_sales set status='paid', paid_at=now(), stripe_payment_intent=$2, note='Recorded afterwards by qa: hand-made link.' where id=$1", [h.saleId, h.pi])
  await db.query("update marketing_leads set status=$2 where id=$1", [h.lead, paidStage])
  await db.query("insert into incoming_payment_resolutions (stripe_session_id, resolution, note, resolved_by) values ($1,'marketing_sale',$2,'qa')", [h.session, `Marketing lead ${h.lead}, sale ${h.saleId}.`])
  const sweep = await settleHandRecordedSales()
  const sh = await state(h)
  const mh = (await db.query("select subject from sandbox_captured_emails where recipient=$1", [h.email])).rows
  ck("F13 a hand-recorded sale: Finance finds its payment by the Stripe id, makes the invoice + credit, matches the row, emails once (the old confirmation row is taken over)", sweep.matched >= 1 && sh.feed.status === "matched" && mh.length === 1 && /Pagamento ricevuto/.test(mh[0].subject), { sweep, sh, mh })
  const sweep2 = await settleHandRecordedSales()
  const mh2 = (await db.query("select count(*)::int n from sandbox_captured_emails where recipient=$1", [h.email])).rows[0].n
  const nih = (await db.query("select count(*)::int n from payments where stripe_payment_id=$1 and invoice_status='Paid'", [h.pi])).rows[0].n
  ck("F13b run again: nothing new (one invoice, one email)", mh2 === 1 && nih === 1, { sweep2, mh2, nih })

  console.log(`\n${pass} passed, ${fail} failed`)
  // clean this run's rows (local test database only, exact tag)
  await db.query("set session_replication_role = replica")
  const leadIds = (await db.query("select id from marketing_leads where leadgen_id like $1", [`${tag}-%`])).rows.map(x => x.id)
  await db.query("delete from incoming_payment_resolutions where stripe_session_id like $1", [`cs_live_${tag}%`])
  await db.query("delete from marketing_sales where lead_id = any($1)", [leadIds])
  await db.query("delete from td_bank_feeds where external_id like $1", [`ch_${tag}%`])
  await db.query("delete from marketing_leads where id = any($1)", [leadIds])
  await db.query("delete from marketing_teams where id=$1", [team])
  await db.end()
  process.exit(fail ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
