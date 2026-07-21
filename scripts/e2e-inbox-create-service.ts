/* eslint-disable no-console -- CLI E2E harness, stdout IS the report. */
/* eslint-disable no-restricted-syntax -- raw writes are DELIBERATE: the harness seeds and tears down its own fixtures, and must inspect raw rows to prove what the route produced. */
/**
 * E2E — "create service from email", run against SANDBOX.
 *
 * Exercises the SAME code path the route takes (the pipeline-shape query, then
 * either createSD or the legacy no-pipeline insert) against real sandbox data,
 * and asserts what actually landed in the database.
 *
 * Scenarios:
 *   1. A pipeline service type  -> real first stage, contact resolved, ONE task
 *   2. A no-pipeline type       -> legacy shape preserved, still works, ONE task
 *   3. ITIN                     -> contact-scoped, so the duplicate guard SEES it
 *   4. ITIN again, same person  -> REFUSED (this door could previously duplicate)
 *   5. ITIN, account with no linked contact -> refused with an actionable reason
 *
 * HONEST LIMIT: this drives the server logic the route calls, not the HTTP
 * handler or the dialog. The dialog's error surfacing is verified separately.
 *
 * Creates its own fixtures and deletes them at the end.
 *
 * Run:  npx tsx scripts/e2e-inbox-create-service.ts   (refuses outside sandbox)
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createSD } from "@/lib/operations/service-delivery"

const SUP = supabaseAdmin
const TAG = "E2E-INBOX-CREATE"

let failures = 0
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

/** Mirrors exactly what the route does to decide which shape it is dealing with. */
async function hasPipeline(serviceType: string): Promise<boolean> {
  const { data } = await SUP.from("pipeline_stages")
    .select("service_type").eq("service_type", serviceType).limit(1)
  return (data?.length ?? 0) > 0
}

/** The route's service branch, minus the HTTP/auth wrapper. */
async function createFromEmail(serviceType: string, accountId: string, companyName: string) {
  const serviceName = `${serviceType} — ${companyName}`
  if (await hasPipeline(serviceType)) {
    const created = await createSD({
      service_type: serviceType,
      service_name: serviceName,
      account_id: accountId,
      notes: `${TAG} | Gmail thread: test-thread`,
    })
    return { id: created.id, viaCreateSD: true }
  }
  const { data, error } = await SUP.from("service_deliveries").insert({
    account_id: accountId, service_type: serviceType, service_name: serviceName,
    pipeline: serviceType, stage: "New", stage_order: 0,
    stage_entered_at: new Date().toISOString(), status: "active",
    assigned_to: "Luca", notes: `${TAG} | Gmail thread: test-thread`,
  }).select("id").single()
  if (error) throw new Error(error.message)
  await SUP.from("tasks").insert({
    task_title: serviceName, description: TAG, assigned_to: "Luca",
    status: "To Do", priority: "Normal", account_id: accountId, delivery_id: data.id,
  })
  return { id: data.id, viaCreateSD: false }
}

async function cleanup(accountIds: string[], contactIds: string[]) {
  for (const id of accountIds) {
    const { data: sds } = await SUP.from("service_deliveries").select("id").eq("account_id", id)
    for (const sd of sds ?? []) await SUP.from("tasks").delete().eq("delivery_id", sd.id)
    await SUP.from("service_deliveries").delete().eq("account_id", id)
    await SUP.from("account_contacts").delete().eq("account_id", id)
    await SUP.from("accounts").delete().eq("id", id)
  }
  for (const id of contactIds) {
    const { data: sds } = await SUP.from("service_deliveries").select("id").eq("contact_id", id)
    for (const sd of sds ?? []) await SUP.from("tasks").delete().eq("delivery_id", sd.id)
    await SUP.from("service_deliveries").delete().eq("contact_id", id)
    await SUP.from("tasks").delete().eq("contact_id", id)
    await SUP.from("contacts").delete().eq("id", id)
  }
}

async function main() {
  const env = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!env.includes("xjcxlmlpeywtwkhstjlw")) {
    console.error(`REFUSING TO RUN — not sandbox: ${env || "(no url)"}`)
    process.exit(1)
  }
  console.log(`\nEnvironment: SANDBOX\n`)

  const accountIds: string[] = []
  const contactIds: string[] = []

  try {
    // ── Fixtures: an account WITH a linked contact, and one WITHOUT ──
    const { data: contact } = await SUP.from("contacts").insert({
      email: "e2e-inbox-create@example.test", full_name: "E2E Inbox Tester",
      updated_at: new Date().toISOString(),
    }).select("id").single()
    if (!contact) throw new Error("fixture contact failed")
    contactIds.push(contact.id)

    const { data: acct } = await SUP.from("accounts").insert({
      company_name: "E2E Inbox Co LLC", account_type: "Client",
    }).select("id").single()
    if (!acct) throw new Error("fixture account failed")
    accountIds.push(acct.id)
    await SUP.from("account_contacts").insert({
      account_id: acct.id, contact_id: contact.id, is_primary: true,
    })

    const { data: lonely } = await SUP.from("accounts").insert({
      company_name: "E2E Inbox NoContact LLC", account_type: "Client",
    }).select("id").single()
    if (!lonely) throw new Error("fixture account 2 failed")
    accountIds.push(lonely.id)

    // ── 1. A pipeline service type ──
    console.log("STEP 1 — a service type WITH a pipeline (EIN)")
    const r1 = await createFromEmail("EIN", acct.id, "E2E Inbox Co LLC")
    const { data: sd1 } = await SUP.from("service_deliveries")
      .select("stage, stage_order, contact_id, status").eq("id", r1.id).single()
    check("went through the operations layer", r1.viaCreateSD)
    check("got a REAL pipeline stage, not the literal 'New'", sd1?.stage !== "New", `stage=${sd1?.stage}`)
    check("contact was resolved from the account", !!sd1?.contact_id)
    const { data: t1 } = await SUP.from("tasks").select("id").eq("delivery_id", r1.id)
    check("exactly ONE task (not two)", (t1?.length ?? 0) === 1, `found ${t1?.length ?? 0}`)

    // ── 2. A no-pipeline service type ──
    console.log("\nSTEP 2 — a service type WITHOUT a pipeline (Support) still works")
    const r2 = await createFromEmail("Support", acct.id, "E2E Inbox Co LLC")
    const { data: sd2 } = await SUP.from("service_deliveries")
      .select("stage, status").eq("id", r2.id).single()
    check("created (capability NOT removed)", !!sd2)
    check("legacy shape preserved", sd2?.stage === "New" && sd2?.status === "active", `stage=${sd2?.stage}`)
    const { data: t2 } = await SUP.from("tasks").select("id").eq("delivery_id", r2.id)
    check("exactly ONE task", (t2?.length ?? 0) === 1, `found ${t2?.length ?? 0}`)

    // ── 3. ITIN becomes visible to the duplicate guard ──
    console.log("\nSTEP 3 — ITIN is contact-scoped, so the duplicate guard can SEE it")
    const r3 = await createFromEmail("ITIN", acct.id, "E2E Inbox Co LLC")
    const { data: sd3 } = await SUP.from("service_deliveries")
      .select("account_id, contact_id, stage").eq("id", r3.id).single()
    check("contact-scoped (account_id null) — the old code left this NULL contact + account-scoped",
      sd3?.account_id === null && !!sd3?.contact_id, `account_id=${sd3?.account_id}`)
    check("real stage, not 'New'", sd3?.stage !== "New", `stage=${sd3?.stage}`)

    // ── 4. THE REGRESSION: a second ITIN for the same person must be refused ──
    console.log("\nSTEP 4 — a SECOND ITIN for the same person (the old bug) is REFUSED")
    let refused = false
    let reason = ""
    try {
      await createFromEmail("ITIN", acct.id, "E2E Inbox Co LLC")
    } catch (e) {
      refused = true
      reason = e instanceof Error ? e.message : String(e)
    }
    check("refused", refused, refused ? reason.slice(0, 90) : "IT WAS CREATED — duplicate ITIN!")
    const { data: itins } = await SUP.from("service_deliveries")
      .select("id").eq("service_type", "ITIN").eq("contact_id", contact.id).eq("status", "active")
    check("still exactly ONE live ITIN for this person", (itins?.length ?? 0) === 1, `found ${itins?.length ?? 0}`)

    // ── 5. ITIN on an account with no linked contact ──
    console.log("\nSTEP 5 — ITIN on an account with NO linked contact fails with a reason")
    let lonelyRefused = false
    let lonelyReason = ""
    try {
      await createFromEmail("ITIN", lonely.id, "E2E Inbox NoContact LLC")
    } catch (e) {
      lonelyRefused = true
      lonelyReason = e instanceof Error ? e.message : String(e)
    }
    check("refused rather than creating a broken record", lonelyRefused)
    check("the reason is specific enough for staff to act on",
      /contact/i.test(lonelyReason), lonelyReason.slice(0, 90))
  } finally {
    console.log("\nCleaning up fixtures…")
    await cleanup(accountIds, contactIds)
    const { data: left } = await SUP.from("service_deliveries").select("id").ilike("notes", `%${TAG}%`)
    console.log(`  fixture services remaining: ${left?.length ?? 0}`)
  }

  console.log(failures === 0 ? "\n✅ E2E PASSED — all checks green\n" : `\n❌ E2E FAILED — ${failures} check(s)\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error("E2E CRASHED:", e); process.exit(1) })
