/* eslint-disable no-console, no-restricted-syntax -- sandbox QA fixtures ("ZZ T21" rows) */
/**
 * "Signing fired twice": N requests for the SAME signed offer at the same moment must make ONE activation, ONE contact, ONE invoice.
 * SANDBOX only (needs the unique index from 20261014-1500 applied).   npx tsx scripts/crm-store/qa-cutover/t21-signing-twice-atomic.ts
 */
import { config } from "dotenv"
config({ path: ".env.local" })

let fails = 0
const ok = (c: unknown, m: string, x?: unknown) => { if (!c) fails++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${c ? "" : " — " + JSON.stringify(x)}`) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  process.env.SANDBOX_MODE = "1"
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const { processOfferSigned } = await import("../../../lib/offers/process-offer-signed")
  const db = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data: tpl } = await db.from("offers").select("*").eq("token", "qa-s1b-b6-f7-2026-v2").maybeSingle()
  const { id: _i, created_at: _c, updated_at: _u, ...rest } = tpl // eslint-disable-line @typescript-eslint/no-unused-vars
  for (const copies of [2, 6]) {
    const tag = `${Date.now()}${copies}`
    const email = `zz-t21-${tag}@example.test`
    const name = `ZZ T21 ${tag}`
    const { data: lead } = await db.from("leads").insert({ full_name: name, email, is_test: true }).select("id").single()
    const token = `zz-t21-${tag}`
    await db.from("offers").insert({ ...rest, token, client_name: name, client_email: email, status: "signed", account_id: null, lead_id: lead.id, contact_id: null })
    await db.from("contracts").insert({ offer_token: token, client_name: name, pdf_path: `zz-t21/${tag}/missing.pdf` })
    console.log(`\n${copies} simultaneous requests for one signed offer`)
    const rs = await Promise.all(Array.from({ length: copies }, () => processOfferSigned(token)))
    ok(rs.every((r) => r.status === 200), "every request answers 200", rs.map((r) => r.status))
    const acts = (await db.from("pending_activations").select("id").eq("offer_token", token)).data ?? []
    const contacts = (await db.from("contacts").select("id").eq("email", email)).data ?? []
    ok(acts.length === 1, "exactly ONE activation", acts.length)
    ok(contacts.length === 1, "exactly ONE contact", contacts.length)
    const inv = contacts[0] ? (await db.from("payments").select("id").eq("contact_id", contacts[0].id)).data ?? [] : []
    ok(inv.length <= 1, "at most ONE invoice", inv.length)
    ok(rs.filter((r) => String(r.body.message ?? "") === "Already pending").length === copies - 1, "the others are told 'Already pending'", rs.map((r) => r.body.message ?? "created"))
  }
  console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
