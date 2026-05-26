/* eslint-disable no-console -- CLI QA tool, stdout IS the UI */
/* eslint-disable no-restricted-syntax -- throwaway QA harness: creates + deletes its own is_test fixtures directly; not a production write path */
/**
 * Sandbox E2E QA for deactivateSD / reactivateSD (throwaway data, self-cleaning).
 *
 * Exercises the REAL helper code against the REAL sandbox schema — catching
 * column/constraint/enum mismatches that the mocked unit tests cannot. Creates
 * an is_test account + SDs + a task, runs every scenario, asserts, then deletes
 * everything it created.
 *
 *   npx tsx scripts/qa/deactivate-reactivate-sd-qa.ts
 *
 * Reads .env.local (sandbox) — same convention as scripts/apply-migration.js.
 * Refuses to run against production.
 */

import { config } from "dotenv"
config({ path: ".env.local" })

const ref = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (ref.includes("ydzipybqeebtpcvsbtvs")) {
  console.error("REFUSING TO RUN AGAINST PRODUCTION. Point .env.local at sandbox.")
  process.exit(1)
}
console.log(`Supabase: ${ref}`)

let passed = 0
let failed = 0
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${extra !== undefined ? ` — got ${JSON.stringify(extra)}` : ""}`)
  }
}

async function main() {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { deactivateSD, reactivateSD } = await import("@/lib/operations/service-delivery")

  // ── Setup ────────────────────────────────────────────
  const { data: acct, error: acctErr } = await supabaseAdmin
    .from("accounts")
    .insert({
      company_name: "QA Deactivate Test LLC",
      account_type: "Client",
      status: "Active",
      ra_renewal_date: "2030-01-01",
      annual_report_due_date: "2030-02-01",
      is_test: true,
    })
    .select("id, ra_renewal_date, annual_report_due_date")
    .single()
  if (acctErr || !acct) throw new Error(`account insert failed: ${acctErr?.message}`)
  const accountId = acct.id
  console.log(`\nTest account: ${accountId}`)

  const mkSD = async (service_type: string) => {
    const { data, error } = await supabaseAdmin
      .from("service_deliveries")
      .insert({
        service_type,
        service_name: `${service_type} — QA`,
        account_id: accountId,
        status: "active",
        stage: "Upcoming",
        stage_order: 1,
        start_date: "2026-05-26",
        stage_entered_at: new Date().toISOString(),
        is_test: true,
      })
      .select("id, updated_at")
      .single()
    if (error || !data) throw new Error(`SD insert (${service_type}) failed: ${error?.message}`)
    return data
  }

  const sdCmra = await mkSD("CMRA Mailing Address")
  const sdRenewal = await mkSD("State RA Renewal")

  // An open task on the CMRA SD to verify cancellation cascade.
  const { data: task, error: taskErr } = await supabaseAdmin
    .from("tasks")
    .insert({
      task_title: "QA open task",
      assigned_to: "Luca",
      status: "To Do",
      account_id: accountId,
      delivery_id: sdCmra.id,
      attachments: [],
      created_by: "QA",
    })
    .select("id")
    .single()
  if (taskErr || !task) throw new Error(`task insert failed: ${taskErr?.message}`)

  const allTaskIds: string[] = [task.id]

  try {
    // ── Scenario 1: deactivate non-renewal, no clear ──
    console.log("\n[1] deactivate CMRA (non-renewal, no clear)")
    const r1 = await deactivateSD({ delivery_id: sdCmra.id, reason: "qa" })
    check("outcome=deactivated", r1.outcome === "deactivated", r1)
    check("tasks_cancelled=1", r1.tasks_cancelled === 1, r1.tasks_cancelled)
    check("renewal_date_cleared=false", r1.renewal_date_cleared === false)
    const { data: sd1 } = await supabaseAdmin.from("service_deliveries").select("status, end_date").eq("id", sdCmra.id).single()
    check("SD status=cancelled", sd1?.status === "cancelled", sd1?.status)
    check("SD end_date set", !!sd1?.end_date)
    const { data: t1 } = await supabaseAdmin.from("tasks").select("status").eq("id", task.id).single()
    check("task status=Cancelled", t1?.status === "Cancelled", t1?.status)
    const { data: a1 } = await supabaseAdmin.from("accounts").select("ra_renewal_date").eq("id", accountId).single()
    check("account ra_renewal_date untouched", a1?.ra_renewal_date === "2030-01-01", a1?.ra_renewal_date)

    // ── Scenario 2: idempotent no-op ──
    console.log("\n[2] deactivate again (already terminal)")
    const r2 = await deactivateSD({ delivery_id: sdCmra.id })
    check("outcome=already_terminal", r2.outcome === "already_terminal", r2)
    check("success=false", r2.success === false)

    // ── Scenario 3: reactivate → fresh task ──
    console.log("\n[3] reactivate CMRA")
    const { data: sdCmraNow } = await supabaseAdmin.from("service_deliveries").select("updated_at").eq("id", sdCmra.id).single()
    const r3 = await reactivateSD({ delivery_id: sdCmra.id, expected_updated_at: sdCmraNow?.updated_at ?? undefined })
    check("outcome=reactivated", r3.outcome === "reactivated", r3)
    check("task_created=true", r3.task_created === true)
    check("renewal_date_empty=false (CMRA not a renewal type)", r3.renewal_date_empty === false)
    const { data: sd3 } = await supabaseAdmin.from("service_deliveries").select("status, end_date").eq("id", sdCmra.id).single()
    check("SD status=active", sd3?.status === "active", sd3?.status)
    check("SD end_date cleared", sd3?.end_date === null, sd3?.end_date)
    const { data: freshTasks } = await supabaseAdmin.from("tasks").select("id, status").eq("delivery_id", sdCmra.id).eq("status", "To Do")
    check("a fresh To Do task exists", (freshTasks?.length ?? 0) >= 1, freshTasks?.length)
    for (const ft of freshTasks ?? []) if (!allTaskIds.includes(ft.id)) allTaskIds.push(ft.id)

    // ── Scenario 4: renewal type + clear_renewal_date ──
    console.log("\n[4] deactivate State RA Renewal with clear_renewal_date")
    const r4 = await deactivateSD({ delivery_id: sdRenewal.id, clear_renewal_date: true, reason: "client handles it" })
    check("outcome=deactivated", r4.outcome === "deactivated", r4)
    check("renewal_date_cleared=true", r4.renewal_date_cleared === true, r4)
    const { data: a4 } = await supabaseAdmin.from("accounts").select("ra_renewal_date").eq("id", accountId).single()
    check("account ra_renewal_date now NULL", a4?.ra_renewal_date === null, a4?.ra_renewal_date)

    // ── Scenario 5: reactivate renewal → empty-date warning ──
    console.log("\n[5] reactivate State RA Renewal (date was cleared)")
    const { data: sdRenNow } = await supabaseAdmin.from("service_deliveries").select("updated_at").eq("id", sdRenewal.id).single()
    const r5 = await reactivateSD({ delivery_id: sdRenewal.id, expected_updated_at: sdRenNow?.updated_at ?? undefined })
    check("outcome=reactivated", r5.outcome === "reactivated", r5)
    check("renewal_date_empty=true (warn)", r5.renewal_date_empty === true, r5)
    for (const ft of (await supabaseAdmin.from("tasks").select("id").eq("delivery_id", sdRenewal.id)).data ?? [])
      if (!allTaskIds.includes(ft.id)) allTaskIds.push(ft.id)

    // ── Scenario 6: not_found / not_cancelled guards ──
    console.log("\n[6] guards")
    const r6a = await deactivateSD({ delivery_id: "00000000-0000-0000-0000-000000000000" })
    check("deactivate missing → not_found", r6a.outcome === "not_found", r6a)
    const r6b = await reactivateSD({ delivery_id: sdCmra.id }) // currently active
    check("reactivate active → not_cancelled", r6b.outcome === "not_cancelled", r6b)
  } finally {
    // ── Teardown ───────────────────────────────────────
    console.log("\nTeardown…")
    const { data: leftover } = await supabaseAdmin
      .from("tasks")
      .select("id")
      .in("delivery_id", [sdCmra.id, sdRenewal.id])
    for (const t of leftover ?? []) if (!allTaskIds.includes(t.id)) allTaskIds.push(t.id)
    if (allTaskIds.length) await supabaseAdmin.from("tasks").delete().in("id", allTaskIds)
    await supabaseAdmin.from("service_deliveries").delete().in("id", [sdCmra.id, sdRenewal.id])
    await supabaseAdmin.from("accounts").delete().eq("id", accountId)
    console.log("Teardown done (account, SDs, tasks deleted).")
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("QA script crashed:", e)
  process.exit(1)
})
