/* eslint-disable no-console -- CLI E2E harness, stdout IS the report. */
/* eslint-disable no-restricted-syntax -- raw writes are DELIBERATE here: the harness seeds its own throwaway fixtures and must bypass the operations layer to prove the DB constraint itself rejects a duplicate. */
/**
 * E2E — duplicate-ITIN regression, run against SANDBOX.
 *
 * Reproduces Marcell Bogyora's exact production scenario end to end:
 *   1. formation wizard submitted under the LEGACY token shape  -> ITIN created
 *   2. same wizard RE-SUBMITTED under the NEW token shape       -> must NOT duplicate
 *
 * Also exercises the collateral defences added with the fix:
 *   3. a member whose email differs only by CASE must not mint a second contact
 *   4. the DB backstop must reject a second ACTIVE ITIN outright
 *
 * Creates its own throwaway fixtures and deletes them at the end.
 *
 * Run:  npx tsx scripts/e2e-itin-dedup.ts     (refuses to run outside sandbox)
 *
 * Negative control (2026-07-20): verified this script FAILS 6 checks when run
 * against the pre-fix code with the unique index dropped — step 2 reproduces
 * the exact production symptom (two live ITIN services => two client cards).
 */

import { config } from "dotenv"
config({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createItinDeliveriesFromWizard } from "@/lib/operations/itin-from-wizard"

const SUP = supabaseAdmin
const EMAIL = "e2e-itin-dedup@example.test"
const MEMBER_EMAIL = "E2E-ITIN-Member@Example.Test" // deliberately mixed case

let failures = 0
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

async function liveItinSds(contactId: string) {
  const { data } = await SUP.from("service_deliveries")
    .select("id, stage, status, notes")
    .eq("service_type", "ITIN")
    .eq("contact_id", contactId)
    .neq("status", "cancelled")
  return data ?? []
}

async function cleanup(contactIds: string[]) {
  for (const id of contactIds) {
    const { data: sds } = await SUP.from("service_deliveries").select("id").eq("contact_id", id)
    for (const sd of sds ?? []) {
      await SUP.from("tasks").delete().eq("delivery_id", sd.id)
      await SUP.from("portal_messages").delete().eq("service_delivery_id", sd.id)
    }
    await SUP.from("tasks").delete().eq("contact_id", id)
    await SUP.from("portal_messages").delete().eq("contact_id", id)
    await SUP.from("service_deliveries").delete().eq("contact_id", id)
    await SUP.from("contacts").delete().eq("id", id)
  }
}

async function main() {
  const env = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!env.includes("xjcxlmlpeywtwkhstjlw")) {
    console.error(`REFUSING TO RUN — not sandbox: ${env}`)
    process.exit(1)
  }
  console.log(`\nEnvironment: SANDBOX (${env})\n`)

  // Clean any residue from a prior run.
  const { data: pre } = await SUP.from("contacts").select("id").in("email", [EMAIL, MEMBER_EMAIL.toLowerCase()])
  await cleanup((pre ?? []).map((c) => c.id))

  const { data: owner } = await SUP.from("contacts")
    .insert({ email: EMAIL, full_name: "E2E ITIN Dedup Owner", updated_at: new Date().toISOString() })
    .select("id")
    .single()
  if (!owner) throw new Error("could not create fixture contact")
  const ownerId = owner.id as string
  const created: string[] = [ownerId]

  try {
    const submitted = {
      owner_needs_itin: true,
      owner_first_name: "E2E",
      owner_last_name: "Dedup",
      owner_email: EMAIL,
    }

    // ── 1. First submission, LEGACY token shape ──
    console.log("STEP 1 — formation wizard submitted (legacy token shape)")
    const r1 = await createItinDeliveriesFromWizard({
      contactId: ownerId,
      leadId: null,
      submitted,
      offerToken: "portal-e2e-dedup-2026",
    })
    check("one ITIN service created", r1.created === 1, `created=${r1.created} skipped=${r1.skipped}`)
    check("exactly one live ITIN in the database", (await liveItinSds(ownerId)).length === 1)

    // ── 2. RE-SUBMISSION, NEW token shape — the exact production bug ──
    console.log("\nSTEP 2 — SAME wizard re-submitted with the NEW token shape (the Marcell bug)")
    const r2 = await createItinDeliveriesFromWizard({
      contactId: ownerId,
      leadId: null,
      submitted,
      offerToken: `portal-e2e-dedup-2026-${ownerId.slice(0, 8)}`,
    })
    check("NO second ITIN created", r2.created === 0, `created=${r2.created}`)
    check("reported as already existing", r2.skipped === 1 && r2.people[0]?.status === "existing")
    const afterResubmit = await liveItinSds(ownerId)
    check("still exactly ONE live ITIN — client sees one card", afterResubmit.length === 1, `found ${afterResubmit.length}`)
    check(
      "the skip is reported to the caller",
      String(r2.people[0]?.detail ?? "").includes("already has a live ITIN"),
      r2.people[0]?.detail ?? "(no detail)",
    )
    check(
      "the existing service's notes were NOT touched (no freetext-matching pattern re-introduced)",
      !String(afterResubmit[0]?.notes ?? "").includes(`portal-e2e-dedup-2026-${ownerId.slice(0, 8)}`),
    )

    // ── 3. Case-different member email must not mint a duplicate contact ──
    console.log("\nSTEP 3 — member re-submitted with differently-cased email")
    const withMember = {
      member_count: 1,
      member_0_member_first_name: "Case",
      member_0_member_last_name: "Test",
      member_0_member_email: MEMBER_EMAIL.toLowerCase(),
      member_0_member_needs_itin: true,
    }
    const m1 = await createItinDeliveriesFromWizard({
      contactId: ownerId, leadId: null, submitted: withMember, offerToken: "portal-e2e-member-2026",
    })
    const memberContactId = m1.people[0]?.contactId
    if (memberContactId) created.push(memberContactId)
    check("member ITIN created", m1.created === 1)

    const m2 = await createItinDeliveriesFromWizard({
      contactId: ownerId,
      leadId: null,
      submitted: { ...withMember, member_0_member_email: MEMBER_EMAIL }, // MIXED CASE
      offerToken: `portal-e2e-member-2026-${ownerId.slice(0, 8)}`,
    })
    check("mixed-case email resolves to the SAME person, no duplicate", m2.created === 0 && m2.skipped === 1)
    const { data: memberContacts } = await SUP.from("contacts").select("id").ilike("email", MEMBER_EMAIL)
    check("no duplicate contact was minted", (memberContacts ?? []).length === 1, `found ${(memberContacts ?? []).length}`)

    // ── 4. DB backstop rejects a second ACTIVE ITIN outright ──
    console.log("\nSTEP 4 — database backstop (bypassing all application code)")
    const { error: rawErr } = await SUP.from("service_deliveries").insert({
      service_type: "ITIN",
      service_name: "E2E raw duplicate attempt",
      stage: "Data Collection",
      status: "active",
      contact_id: ownerId,
      account_id: null,
      is_test: true,
    })
    check(
      "raw duplicate insert REJECTED by the database",
      !!rawErr && (rawErr.code === "23505" || /duplicate key/i.test(rawErr.message)),
      rawErr ? rawErr.code ?? rawErr.message : "insert unexpectedly SUCCEEDED",
    )

    // ── 5. A cancelled ITIN must not block a fresh one ──
    console.log("\nSTEP 5 — a cancelled ITIN must not block a legitimate new application")
    const live = await liveItinSds(ownerId)
    const cancelledId = live[0].id
    await SUP.from("service_deliveries").update({ status: "cancelled" }).eq("id", cancelledId)
    const r3 = await createItinDeliveriesFromWizard({
      contactId: ownerId, leadId: null, submitted, offerToken: "portal-e2e-after-cancel-2026",
    })
    check("new ITIN allowed once the previous one is cancelled", r3.created === 1, `created=${r3.created}`)

    // ── 6. Reactivating the cancelled one must REFUSE, and say why ──
    // This is Marcell's exact live state: one active + one cancelled. Before the
    // fix this hit the unique index inside a throwing writer, so the CRM button
    // died with no toast at all.
    console.log("\nSTEP 6 — reactivating a cancelled ITIN while an active one exists")
    const { reactivateSD } = await import("@/lib/operations/service-delivery")
    const react = await reactivateSD({ delivery_id: cancelledId, actor: "e2e" })
    check("refused, not crashed", react.success === false, `outcome=${react.outcome}`)
    check("outcome is a conflict", react.outcome === "conflict", String(react.outcome))
    check(
      "explains itself in plain English",
      /already has a live ITIN/i.test(react.error ?? ""),
      react.error ?? "(no message)",
    )
    check(
      "the cancelled service really did stay cancelled",
      (await liveItinSds(ownerId)).filter(s => s.id === cancelledId).length === 0,
    )
  } finally {
    console.log("\nCleaning up fixtures…")
    await cleanup(created)
    const { data: leftover } = await SUP.from("contacts").select("id").in("email", [EMAIL, MEMBER_EMAIL.toLowerCase()])
    console.log(`  fixtures remaining: ${(leftover ?? []).length}`)
  }

  console.log(failures === 0 ? "\n✅ E2E PASSED — all checks green\n" : `\n❌ E2E FAILED — ${failures} check(s) failed\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("E2E CRASHED:", e)
  process.exit(1)
})
