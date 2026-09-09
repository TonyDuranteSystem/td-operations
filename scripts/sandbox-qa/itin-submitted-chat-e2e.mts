/**
 * E2E QA for "ITIN Submitted to IRS now also posts a portal-chat message"
 * (docs/systems/flows.md, 2026-09-08; dev job 994e0810). Drives the REAL
 * advanceServiceDelivery / revertServiceDelivery / createSD functions against
 * seeded sandbox fixtures. Sandbox-only. Cleans up its own fixtures.
 *
 *   npx tsx scripts/sandbox-qa/itin-submitted-chat-e2e.mts
 *
 * Scenarios:
 *  1. Happy path — CAA Review -> Submitted to IRS posts exactly one chat
 *     message, topic "ITIN", the approved client_description text, and the
 *     milestone email is still attempted (additive, not a replacement).
 *  2. Topic-consistency reality check — does a real, CURRENT-year case's
 *     existing Client Signing chat message land under the SAME topic as the
 *     new Submitted-to-IRS message, or are they already split today?
 *  3. Duplicate-send exposure — revert Submitted to IRS back to CAA Review,
 *     then re-advance. Does the client get the chat message twice? (Known,
 *     pre-existing gap shared with the email — observed, not fixed here.)
 *  4. Bulk-correction safety — skip_notify:true must produce NO chat message.
 *  5. Scoping — every OTHER ITIN stage transition must NOT post to the ITIN
 *     chat topic (only Submitted to IRS has the flag on).
 *  6. Cross-service safety — a different service_type's own milestone email
 *     stage must be completely unaffected (zero blast radius).
 *  7. Dashboard false-flag check — Submitted to IRS must NOT be registered
 *     as a client-action-required stage (would wrongly show "your turn").
 */
import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

const REF = process.env.NEXT_PUBLIC_SUPABASE_URL || ""
if (!REF.includes("xjcxlmlpeywtwkhstjlw")) {
  console.error("ABORT: not the sandbox ref. Got:", REF)
  process.exit(1)
}

import { createClient } from "@supabase/supabase-js"
const sb = createClient(REF, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

import { createSD, revertServiceDelivery } from "../../lib/operations/service-delivery"
import { advanceServiceDelivery } from "../../lib/service-delivery"
import { actionStageConfigFor } from "../../lib/portal/action-stage-registry"

const TAG = "QA-ITIN-CHAT-E2E"
let pass = 0
let fail = 0
const results: string[] = []
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++
    results.push(`  ✅ ${name}`)
  } else {
    fail++
    results.push(`  ❌ ${name} — ${detail}`)
  }
}
function note(msg: string) {
  results.push(`  ℹ️  ${msg}`)
}

async function cleanup() {
  const { data: contacts } = await sb.from("contacts").select("id").ilike("full_name", `${TAG}%`)
  const contactIds = (contacts ?? []).map((c) => c.id)
  if (contactIds.length) {
    await sb.from("portal_messages").delete().in("contact_id", contactIds)
    await sb.from("tasks").delete().in("contact_id", contactIds)
    await sb.from("service_deliveries").delete().in("contact_id", contactIds)
    await sb.from("contacts").delete().in("id", contactIds)
  }
}

async function makeContact(label: string): Promise<string> {
  const { data, error } = await sb
    .from("contacts")
    .insert({ full_name: `${TAG} ${label}`, email: `${TAG.toLowerCase()}-${label.toLowerCase()}@example.invalid`, language: "English" })
    .select("id")
    .single()
  if (error || !data) throw new Error(`makeContact(${label}) failed: ${error?.message}`)
  return data.id
}

async function chatRows(contactId: string) {
  const { data } = await sb
    .from("portal_messages")
    .select("id, topic, message, sender_type, service_delivery_id")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: true })
  return data ?? []
}

async function run() {
  await cleanup()

  // ── Scenario 7 (cheap, no DB needed): dashboard false-flag check ──
  const actionCfg = actionStageConfigFor("ITIN", "Submitted to IRS")
  check(
    "7. 'Submitted to IRS' is NOT registered as a client-action stage (no false 'your turn' flag)",
    actionCfg === null,
    `actionStageConfigFor returned: ${JSON.stringify(actionCfg)}`,
  )

  // ── Scenario 1: happy path ──
  const contact1 = await makeContact("Case1")
  const sd1 = await createSD({
    service_type: "ITIN",
    contact_id: contact1,
    target_stage: "CAA Review",
  })
  

  const adv1 = await advanceServiceDelivery({
    delivery_id: sd1.id,
    target_stage: "Submitted to IRS",
    actor: "qa-e2e",
  })
  check("1a. Advance to Submitted to IRS succeeds", adv1.success, adv1.error)
  const rows1 = await chatRows(contact1)
  const itinRows1 = rows1.filter((r) => r.topic === "ITIN")
  check("1b. Exactly one ITIN-topic chat message posted", itinRows1.length === 1, `found ${itinRows1.length}: ${JSON.stringify(rows1)}`)
  check(
    "1c. Message text matches the approved client_description",
    itinRows1[0]?.message === "Your ITIN application has been mailed to the IRS.",
    itinRows1[0]?.message,
  )
  check("1d. Sender is admin (staff-authored system message)", itinRows1[0]?.sender_type === "admin", itinRows1[0]?.sender_type)
  check(
    "1d2. Message is stamped with this service_delivery_id (so the staff Workspace room can find it — this SD has no account_id, so the room's query has no other way to match it)",
    itinRows1[0]?.service_delivery_id === sd1.id,
    `expected ${sd1.id}, got ${itinRows1[0]?.service_delivery_id}`,
  )
  check(
    "1e. auto_triggers records the chat post",
    adv1.auto_triggers.some((t) => t.includes("Stage-change chat message posted")),
    JSON.stringify(adv1.auto_triggers),
  )
  check(
    "1f. auto_triggers ALSO shows the milestone email was attempted (additive, not replaced)",
    adv1.auto_triggers.some((t) => t.toLowerCase().includes("stage-change email")),
    JSON.stringify(adv1.auto_triggers),
  )

  // ── Scenario 2: topic-consistency reality check ──
  const contact2 = await makeContact("Case2")
  const sd2 = await createSD({ service_type: "ITIN", contact_id: contact2 }) // starts at Data Collection
  
  const advToSigning = await advanceServiceDelivery({
    delivery_id: sd2.id,
    target_stage: "Client Signing",
    actor: "qa-e2e",
  })
  check("2a. Advance into Client Signing succeeds", advToSigning.success, advToSigning.error)
  const rowsAfterSigning = await chatRows(contact2)
  const signingTopic = rowsAfterSigning[0]?.topic ?? null
  note(`Client Signing chat message topic for a CURRENT case: ${JSON.stringify(signingTopic)}`)

  const advToSubmitted = await advanceServiceDelivery({
    delivery_id: sd2.id,
    target_stage: "Submitted to IRS",
    actor: "qa-e2e",
  })
  check("2b. Advance to Submitted to IRS succeeds", advToSubmitted.success, advToSubmitted.error)
  const rowsAfterSubmitted = await chatRows(contact2)
  const submittedRow = rowsAfterSubmitted.find((r) => r.topic === "ITIN")
  check("2c. Submitted-to-IRS message posted under topic 'ITIN'", !!submittedRow, JSON.stringify(rowsAfterSubmitted))
  const sameTopic = signingTopic !== null && signingTopic === "ITIN"
  check(
    "2d. Client Signing's topic MATCHES the new fixed 'ITIN' topic (same conversation) for a case active right now",
    sameTopic,
    `Client Signing topic was ${JSON.stringify(signingTopic)}, new message topic is "ITIN" — ${sameTopic ? "MATCH" : "MISMATCH: this client's conversation is still split across two topics even after this fix"}`,
  )

  // ── Scenario 3: duplicate-send exposure (revert then re-advance) ──
  const beforeRevertCount = (await chatRows(contact1)).filter((r) => r.topic === "ITIN").length
  const rev = await revertServiceDelivery({ delivery_id: sd1.id, actor: "qa-e2e" } as any)
  note(`revertServiceDelivery result: ${JSON.stringify(rev)}`)
  const readvance = await advanceServiceDelivery({
    delivery_id: sd1.id,
    target_stage: "Submitted to IRS",
    actor: "qa-e2e",
  })
  check("3a. Re-advance after revert still succeeds", readvance.success, readvance.error)
  const afterRevertCount = (await chatRows(contact1)).filter((r) => r.topic === "ITIN").length
  note(
    `3b. ITIN-topic chat messages before revert: ${beforeRevertCount}, after revert+re-advance: ${afterRevertCount} — ` +
      (afterRevertCount > beforeRevertCount
        ? "DUPLICATE CONFIRMED (pre-existing gap shared with the milestone email — not introduced or fixed by this change)"
        : "no duplicate observed in this run"),
  )

  // ── Scenario 4: bulk-correction safety (skip_notify) ──
  const contact4 = await makeContact("Case4")
  const sd4 = await createSD({ service_type: "ITIN", contact_id: contact4, target_stage: "CAA Review" })
  
  const adv4 = await advanceServiceDelivery({
    delivery_id: sd4.id,
    target_stage: "Submitted to IRS",
    actor: "qa-e2e",
    skip_notify: true,
  })
  check("4a. skip_notify advance succeeds", adv4.success, adv4.error)
  const rows4 = await chatRows(contact4)
  check("4b. skip_notify suppresses the chat message entirely", rows4.length === 0, JSON.stringify(rows4))

  // ── Scenario 5: scoping — other ITIN stages don't post to the ITIN chat topic ──
  const contact5 = await makeContact("Case5")
  const sd5 = await createSD({ service_type: "ITIN", contact_id: contact5 }) // Data Collection
  
  await advanceServiceDelivery({ delivery_id: sd5.id, target_stage: "Document Preparation", actor: "qa-e2e" })
  await advanceServiceDelivery({ delivery_id: sd5.id, target_stage: "Documents Received", actor: "qa-e2e" })
  await advanceServiceDelivery({ delivery_id: sd5.id, target_stage: "CAA Review", actor: "qa-e2e" })
  const rows5 = await chatRows(contact5)
  const itinTopicRows5 = rows5.filter((r) => r.topic === "ITIN")
  check(
    "5. No stage before Submitted to IRS posts to the fixed 'ITIN' chat topic",
    itinTopicRows5.length === 0,
    JSON.stringify(rows5),
  )

  // ── Scenario 6: cross-service safety — zero blast radius on another service ──
  const { data: closureStages } = await sb
    .from("pipeline_stages")
    .select("stage_name, notify_client_email, notify_client_chat")
    .eq("service_type", "Company Closure")
    .order("stage_order")
  const closureMilestone = (closureStages ?? []).find((s) => s.notify_client_email)
  if (closureMilestone) {
    check(
      "6. A different service's own milestone-email stage was NOT touched by this migration (notify_client_chat still false)",
      closureMilestone.notify_client_chat === false,
      JSON.stringify(closureMilestone),
    )
  } else {
    note("6. SKIPPED — no Company Closure stage with notify_client_email=true found in sandbox to check against")
  }

  console.log(`\n${TAG} results:\n${results.join("\n")}\n`)
  console.log(`TOTAL: ${pass} passed, ${fail} failed`)

  await cleanup()
  process.exit(fail > 0 ? 1 : 0)
}

run().catch(async (err) => {
  console.error("E2E script crashed:", err)
  await cleanup()
  process.exit(1)
})
