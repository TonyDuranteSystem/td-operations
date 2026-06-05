/* eslint-disable no-console -- dev-only sandbox QA driver for Phase D, never shipped to runtime */
/* eslint-disable no-restricted-syntax -- throwaway test fixtures + cleanup; intentionally raw writes, not production code paths */
/**
 * Phase D real-DB E2E (sandbox) — prompt_version + env lane + batch grouping.
 *
 * Mocked unit tests can't catch a column-name typo or a real-Postgres filter
 * mismatch. This drives the REAL functions against the sandbox and asserts:
 *   - createThreadSummary writes thread_summaries.prompt_version,
 *   - batchPropose mints ONE batch_id across proposals and stamps env on each row
 *     (proving the env + batch_id column writes land in real Postgres),
 *   - claimApproval (the executor's atomic claim) SKIPS a row whose env != the
 *     executor's lane and CLAIMS one that matches (the staging-lane guard).
 * Then it cleans up everything it created, including the CRM-mirror messages the
 * propose notifications wrote to the system team thread.
 *
 * Run: npx tsx scripts/test-phase-d-sandbox.ts
 */

import { config as dotenvConfig } from "dotenv"
dotenvConfig({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createThreadSummary, getThreadSummary } from "@/lib/ai-agent/thread-summaries"
import { batchPropose, WORKER_PROMPT_VERSION } from "@/lib/ai-agent/worker-tools"
import { claimApproval } from "@/lib/ai-agent/approval-executor"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? "") }
}

const RUN = Date.now().toString(16)
const HEX12 = RUN.padStart(12, "0").slice(-12)
const TID = `00000000-0000-4000-8002-${HEX12}`
const MARK = `PHASE-D-E2E-${RUN}`
const LANE_A = `phase-d-a-${RUN}`
const LANE_B = `phase-d-b-${RUN}`

async function main() {
  const ref = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!ref.includes("xjcxlmlpeywtwkhstjlw")) {
    console.error(`REFUSING: not sandbox (NEXT_PUBLIC_SUPABASE_URL=${ref}).`)
    process.exit(1)
  }
  console.log(`Phase D E2E — sandbox, run ${RUN}\n`)

  let batchId = ""
  try {
    // 1) prompt_version write
    console.log(`  (WORKER_PROMPT_VERSION = ${WORKER_PROMPT_VERSION.slice(0, 16)}…, len ${WORKER_PROMPT_VERSION.length})`)
    const created = await createThreadSummary(TID, "bug_report", "Phase D prompt-version E2E", WORKER_PROMPT_VERSION)
    check("createThreadSummary stores prompt_version", created?.prompt_version === WORKER_PROMPT_VERSION, created?.prompt_version)
    const reread = await getThreadSummary(TID)
    check("prompt_version reads back", reread?.prompt_version === WORKER_PROMPT_VERSION)
    check("prompt_version is a 64-char sha256 hex", /^[0-9a-f]{64}$/.test(WORKER_PROMPT_VERSION))

    // 2) batchPropose — one batch_id + env on each row (real column writes)
    process.env.APPROVAL_ENV = LANE_A
    const batch = await batchPropose([
      { tool_name: "create_task", params: { task_title: `${MARK} one` }, rationale: MARK },
      { tool_name: "create_task", params: { task_title: `${MARK} two` }, rationale: MARK },
    ])
    batchId = batch.batch_id
    check("batchPropose returns a batch_id + count 2", !!batch.batch_id && batch.count === 2, batch)

    const { data: batchRows } = await db
      .from("approval_queue")
      .select("id, batch_id, env, status, tool_name")
      .eq("batch_id", batchId)
    const rows = (batchRows ?? []) as Array<{ id: string; batch_id: string; env: string; status: string }>
    check("both rows persisted under the shared batch_id", rows.length === 2, rows.length)
    check("every batch row carries env = the proposer's lane", rows.every((r) => r.env === LANE_A), rows.map((r) => r.env))
    check("every batch row is pending", rows.every((r) => r.status === "pending"))

    // 3) executor env filter — approve one row, then claim from the wrong/right lane
    const target = rows[0]
    await db.from("approval_queue").update({ status: "approved" }).eq("id", target.id)

    process.env.APPROVAL_ENV = LANE_B // wrong lane
    const wrongLane = await claimApproval(target.id)
    check("claimApproval SKIPS a row whose env != executor lane", wrongLane === null)
    const { data: afterWrong } = await db.from("approval_queue").select("status").eq("id", target.id).maybeSingle()
    check("row stays 'approved' after a wrong-lane claim (never executed)", afterWrong?.status === "approved", afterWrong)

    process.env.APPROVAL_ENV = LANE_A // right lane
    const rightLane = await claimApproval(target.id)
    check("claimApproval CLAIMS a same-lane approved row", rightLane?.id === target.id, rightLane)
    const { data: afterRight } = await db.from("approval_queue").select("status").eq("id", target.id).maybeSingle()
    check("row moved to 'executing' after a same-lane claim", afterRight?.status === "executing", afterRight)
  } finally {
    // cleanup: approval rows, the CRM-mirror messages, and the thread summary
    if (batchId) await db.from("approval_queue").delete().eq("batch_id", batchId)
    await db.from("internal_messages").delete().like("message", `%${MARK}%`)
    await db.from("thread_summaries").delete().eq("thread_id", TID)
    console.log("\n🧹 cleanup done")
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
