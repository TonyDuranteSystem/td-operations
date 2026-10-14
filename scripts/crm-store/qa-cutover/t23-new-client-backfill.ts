/* eslint-disable no-console, no-restricted-syntax -- sandbox QA fixtures ("ZZ T23" rows) */
/**
 * The go-live backfill (a client who signed + paid BEFORE the new-clients switch — the Lahmar case). SANDBOX only.
 *   npx tsx scripts/crm-store/qa-cutover/t23-new-client-backfill.ts
 */
import { config } from "dotenv"
import { PDFDocument } from "pdf-lib"
config({ path: ".env.local" })

let fails = 0
const ok = (c: unknown, m: string, x?: unknown) => { if (!c) fails++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${c ? "" : " — " + JSON.stringify(x)}`) }

async function main() {
  if (!(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("xjcxlmlpeywtwkhstjlw")) throw new Error("sandbox only")
  process.env.SANDBOX_MODE = "1"; process.env.STORE_NEW_CLIENTS = "0"
  const { supabaseAdmin } = await import("../../../lib/supabase-admin")
  const { processOfferSigned } = await import("../../../lib/offers/process-offer-signed")
  const { createSD } = await import("../../../lib/operations/service-delivery")
  const { planNewClientBackfill, runNewClientBackfill, BackfillRefused } = await import("../../../lib/crm-store/new-client-backfill")
  const db = supabaseAdmin as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data: tpl } = await db.from("offers").select("*").eq("token", "qa-s1b-b6-f7-2026-v2").maybeSingle()
  const { id: _i, created_at: _c, updated_at: _u, ...rest } = tpl // eslint-disable-line @typescript-eslint/no-unused-vars
  const tag = Date.now(); const email = `zz-t23-${tag}@example.test`; const name = `ZZ T23 ${tag}`
  const d = await PDFDocument.create(); d.addPage([300, 300]).drawText(`contract ${tag}`)
  const bytes = Buffer.from(await d.save())

  console.log("\n1. a client signs and pays while the switch is OFF (everything goes the old way)")
  const { data: lead } = await db.from("leads").insert({ full_name: name, email, is_test: true }).select("id").single()
  const token = `zz-t23-${tag}`
  await db.from("offers").insert({ ...rest, token, client_name: name, client_email: email, status: "signed", account_id: null, lead_id: lead.id, contact_id: null })
  const path = `zz-t23/${tag}/contract.pdf`
  await db.storage.from("signed-contracts").upload(path, bytes, { contentType: "application/pdf", upsert: true })
  await db.from("contracts").insert({ offer_token: token, client_name: name, pdf_path: path })
  await processOfferSigned(token)
  const { data: contact } = await db.from("contacts").select("id").eq("email", email).single()
  const sd = (await createSD({ service_type: "Company Formation", contact_id: contact.id, account_id: null, service_name: `Company Formation - ${name}` } as never) as { id: string }).id
  const owners = async () => ((await db.from("store_owners").select("id, kind").or(`contact_id.eq.${contact.id},service_delivery_id.eq.${sd}`)).data ?? []) as Array<{ id: string; kind: string }>
  ok((await owners()).length === 0, "nothing in the new storage yet")

  console.log("\n2. switch still OFF → the backfill refuses")
  const off = await planNewClientBackfill(contact.id)
  ok(!off.allowed && /switched off/.test(off.reason ?? ""), "plain refusal", off)

  process.env.STORE_NEW_CLIENTS = "1"
  console.log("\n3. switch ON → dry run shows the work")
  const plan = await planNewClientBackfill(contact.id)
  ok(plan.allowed && plan.contracts.length === 1 && plan.contracts[0].hasPdf && plan.formations.length === 1 && !plan.formations[0].hasStorage, "one contract + one formation without storage", plan)
  ok((await owners()).length === 0, "the dry run changed nothing")

  console.log("\n4. run it")
  const r = await runNewClientBackfill(contact.id)
  ok(r.steps.every((s) => s.status === "done"), "every step done", r.steps)
  const own = await owners()
  ok(own.some((o) => o.kind === "person") && own.some((o) => o.kind === "formation"), "the person and the formation have their storage", own)
  const doc = (await db.from("documents").select("drive_file_id, contact_id, account_id, portal_visible, document_type_name").eq("contact_id", contact.id).like("drive_file_id", "store:%")).data ?? []
  ok(doc.length === 1 && doc[0].portal_visible === false && doc[0].document_type_name === "Signed Contract", "the contract is listed on the contact, hidden from the client", doc)

  console.log("\n5. run it again → nothing new")
  const r2 = await runNewClientBackfill(contact.id)
  ok(r2.steps.every((s) => s.status === "already"), "all 'already'", r2.steps)
  ok(((await db.from("documents").select("id").eq("contact_id", contact.id).like("drive_file_id", "store:%")).data ?? []).length === 1, "still ONE contract record")

  console.log("\n6. a returning client is refused")
  const ret = (await db.from("contacts").insert({ full_name: `ZZ T23 returning ${tag}`, email: `zz-t23-ret-${tag}@example.test` }).select("id").single()).data
  const { data: acc } = await db.from("accounts").select("id").limit(1).single()
  await db.from("account_contacts").insert({ account_id: acc.id, contact_id: ret.id, role: "Owner" })
  let refused = false
  try { await runNewClientBackfill(ret.id) } catch (e) { refused = e instanceof BackfillRefused }
  ok(refused, "refused with a plain reason (not a new client)")
  await db.from("account_contacts").delete().eq("account_id", acc.id).eq("contact_id", ret.id)

  console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
