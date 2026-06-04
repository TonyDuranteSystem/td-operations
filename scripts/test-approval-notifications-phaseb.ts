/* eslint-disable no-console -- dev-only sandbox QA driver for Phase B, never shipped to runtime */
/* eslint-disable no-restricted-syntax -- throwaway test fixtures + cleanup; intentionally raw writes, not production code paths */
/**
 * Phase B real-DB E2E (sandbox) — Hermes ↔ Claude approval notifications.
 *
 * Mocked unit tests can't catch NOT-NULL / wrong-column DB errors (see the Slice 3
 * lesson in docs/systems/agent-bridge.md). This drives the REAL functions against
 * the sandbox Postgres and asserts the rows land with the right shape, then cleans
 * up everything it created.
 *
 * Run: npx tsx scripts/test-approval-notifications-phaseb.ts
 */

import { config as dotenvConfig } from "dotenv"
dotenvConfig({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  sendApprovalNotification,
  emitApprovalOutcome,
  runNotificationSweep,
} from "@/lib/ai-agent/approval-notifications"

const SYSTEM_THREAD_TITLE = "🤖 Approval Rail (system)"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? "") }
}

async function main() {
  const ref = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!ref.includes("xjcxlmlpeywtwkhstjlw")) {
    console.error(`REFUSING: not sandbox (NEXT_PUBLIC_SUPABASE_URL=${ref}).`)
    process.exit(1)
  }
  console.log("Phase B notification E2E — sandbox\n")

  const createdApprovalIds: string[] = []
  const createdMessageIds: string[] = []

  // 1) sendApprovalNotification('proposed') — creates/reuses the system thread + a message.
  console.log("1) sendApprovalNotification('proposed')")
  const fakeId1 = "e2e10000-0000-0000-0000-000000000001"
  const ok1 = await sendApprovalNotification(
    { id: fakeId1, tool_name: "create_task", params: { task_title: "E2E phase-b proposed" }, rationale: "e2e" },
    "proposed",
  )
  check("returns true", ok1 === true)

  const { data: threadRows } = await db
    .from("internal_threads").select("id").eq("title", SYSTEM_THREAD_TITLE).order("created_at", { ascending: true }).limit(1)
  const threadId = threadRows?.[0]?.id
  check("system thread exists", !!threadId, threadRows)

  const { data: m1 } = await db
    .from("internal_messages").select("id, message, sender_name").eq("thread_id", threadId).order("created_at", { ascending: false }).limit(1)
  if (m1?.[0]) createdMessageIds.push(m1[0].id)
  check("proposed message written", !!m1?.[0]?.message?.includes("New action proposed"), m1?.[0]?.message?.slice(0, 60))
  check("sender_name is 'Approval Rail'", m1?.[0]?.sender_name === "Approval Rail")

  // 2) emitApprovalOutcome on a real approval_queue row.
  console.log("\n2) emitApprovalOutcome('executed') on a seeded approval row")
  const { data: ins, error: insErr } = await db
    .from("approval_queue")
    .insert({ requested_by: "worker", tool_name: "create_task", params: { task_title: "E2E phase-b outcome" }, params_hash: "e2e", status: "executed", notification_sent: false })
    .select("id").single()
  if (insErr) { console.error("seed insert failed:", insErr); process.exit(1) }
  const apId = ins.id as string
  createdApprovalIds.push(apId)

  const ok2 = await emitApprovalOutcome({
    id: apId, tool_name: "create_task", status: "executed",
    summary: "Proposal create_task executed successfully.",
    row: { id: apId, tool_name: "create_task", params: { task_title: "E2E phase-b outcome" } },
  })
  check("returns true", ok2 === true)

  const { data: apAfter } = await db.from("approval_queue").select("notification_sent").eq("id", apId).single()
  check("notification_sent flipped to true", apAfter?.notification_sent === true, apAfter)

  const { data: cb } = await db
    .from("agent_messages").select("id, sender, recipient, context_json").contains("context_json", { approval_id: apId }).limit(1)
  check("agent_messages callback written (worker→hermes)", cb?.[0]?.sender === "worker" && cb?.[0]?.recipient === "hermes", cb?.[0])

  const { data: m2 } = await db
    .from("internal_messages").select("id, message").eq("thread_id", threadId).order("created_at", { ascending: false }).limit(1)
  if (m2?.[0]) createdMessageIds.push(m2[0].id)
  check("CRM mirror message written (✅ executed)", !!m2?.[0]?.message?.includes("Action executed"), m2?.[0]?.message?.slice(0, 60))

  // 3) runNotificationSweep retries a terminal row whose flag is still false.
  console.log("\n3) runNotificationSweep retries an un-notified terminal row")
  const { data: ins3 } = await db
    .from("approval_queue")
    .insert({ requested_by: "worker", tool_name: "create_task", params: { task_title: "E2E phase-b sweep" }, params_hash: "e2e", status: "failed", notification_sent: false, error_text: "e2e failure" })
    .select("id").single()
  const sweepId = ins3.id as string
  createdApprovalIds.push(sweepId)

  const notified = await runNotificationSweep()
  check("sweep notified >= 1", typeof notified === "number" && notified >= 1, notified)
  const { data: sweepAfter } = await db.from("approval_queue").select("notification_sent").eq("id", sweepId).single()
  check("swept row notification_sent flipped", sweepAfter?.notification_sent === true, sweepAfter)

  // ── Cleanup ──────────────────────────────────────────────────────────────
  console.log("\n🧹 cleanup")
  // Remove the agent_messages + internal_messages this run created for our rows.
  for (const apId of createdApprovalIds) {
    await db.from("agent_messages").delete().contains("context_json", { approval_id: apId })
  }
  await db.from("internal_messages").delete().in("id", createdMessageIds.filter(Boolean))
  // Also delete any internal_messages on the system thread that mention our e2e marker (sweep mirror).
  await db.from("internal_messages").delete().eq("thread_id", threadId).like("message", "%E2E phase-b%")
  await db.from("approval_queue").delete().in("id", createdApprovalIds)
  // Drop the system thread only if it now has no messages left (keep it if real data exists).
  const { data: remaining } = await db.from("internal_messages").select("id").eq("thread_id", threadId).limit(1)
  if (!remaining?.length) {
    await db.from("internal_threads").delete().eq("id", threadId)
    console.log("  removed empty system thread")
  } else {
    console.log("  system thread kept (still has messages)")
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
