/* eslint-disable no-console -- dev-only sandbox QA driver for Phase 2 Slice 3, never shipped to runtime */
/* eslint-disable no-restricted-syntax -- throwaway test fixtures + reverts; intentionally raw writes, not production code paths */
/**
 * Phase 2 Slice 3 — systematic approval-rail E2E driver (sandbox only).
 *
 * Drives all 12 approvable tools through the FULL propose → approve → execute
 * cycle against sandbox, exactly as production would:
 *   1. proposeAction(...)                  → queues a pending approval_queue row
 *   2. assert status='pending' + params_hash present
 *   3. UPDATE status='approved' (decided_by='antonio')   (the approve transition)
 *   4. HTTP GET /api/cron/approval-executor?id=<id>  with CRON_SECRET  (the executor)
 *   5. assert terminal status + result + outcome callback in agent_messages
 *   6. tool-specific effect verification
 *   7. full cleanup (delete every row this run created / restore mutated fields)
 *
 * Execution goes through the real HTTP route (the same path approval_decide's
 * fireExecutorTrigger uses in production), not in-process, so auth + route +
 * executor are all exercised.
 *
 * SANDBOX_MODE=1 means Gmail send + Drive writes are mocked to success — no real
 * email leaves the building, no real Drive mutation. Drive/Gmail read tools that
 * are NOT mocked are driven with fake IDs to produce controlled failures.
 *
 * Run (dev server must be up, APPROVAL_RAIL_ENABLED=true in .env.local):
 *   npx tsx scripts/test-approval-rail-s3.ts
 */

import { config as dotenvConfig } from "dotenv"
dotenvConfig({ path: ".env.local" })

import { proposeAction } from "@/lib/ai-agent/worker-tools"
import { supabaseAdmin } from "@/lib/supabase-admin"

// ── R104 guard: refuse to run against anything but sandbox ──
const SANDBOX_REF = "xjcxlmlpeywtwkhstjlw"
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(SANDBOX_REF)) {
  console.error(`✋ Refusing to run: NEXT_PUBLIC_SUPABASE_URL is not the sandbox ref (${SANDBOX_REF}).`)
  process.exit(1)
}

const BASE = "http://localhost:3000"
const CRON_SECRET = process.env.CRON_SECRET ?? ""
const RUN = Date.now().toString(36)
const ACCT = "5bb0efd6-5ce4-4123-a450-004ad08c9738" // QA Alpha LLC

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

// ── tracking for cleanup ──
const created = {
  approvalIds: [] as string[],
  taskIds: [] as string[],
  conversationIds: [] as string[],
  memoryKeys: [] as string[],
  contactId: null as string | null,
  serviceId: null as string | null,
  deliveryId: null as string | null,
}
let originalAccountNotes: string | null = null

interface CaseResult {
  tool: string
  proposed: boolean
  pending: boolean
  hashPresent: boolean
  approved: boolean
  httpOk: boolean
  finalStatus: string
  expectedStatus: string
  callback: boolean
  effectOk: boolean | null
  issues: string[]
}
const results: CaseResult[] = []

function extractId(proposeOutput: string): string | null {
  const m = proposeOutput.match(/id=([0-9a-f-]{36})/i)
  return m ? m[1] : null
}

async function execViaHttp(id: string): Promise<{ ok: boolean; body: unknown }> {
  try {
    const res = await fetch(`${BASE}/api/cron/approval-executor?id=${id}`, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, body }
  } catch (err) {
    return { ok: false, body: { error: err instanceof Error ? err.message : String(err) } }
  }
}

interface Case {
  tool: string
  params: Record<string, unknown>
  expected: "executed" | "failed"
  verify?: (result: unknown) => Promise<string[]>
}

/**
 * Run one full propose→approve→execute cycle and record the result.
 */
async function runCase(c: Case): Promise<void> {
  const idemKey = `qa-s3-${c.tool}-${RUN}`
  const r: CaseResult = {
    tool: c.tool,
    proposed: false,
    pending: false,
    hashPresent: false,
    approved: false,
    httpOk: false,
    finalStatus: "(none)",
    expectedStatus: c.expected,
    callback: false,
    effectOk: c.verify ? false : null,
    issues: [],
  }

  try {
    // 1) propose
    const out = await proposeAction({
      tool_name: c.tool,
      params: c.params,
      rationale: `[QA S3] rail test for ${c.tool}`,
      idempotency_key: idemKey,
    })
    const id = extractId(out)
    if (!id) {
      r.issues.push(`propose returned no id: ${out.slice(0, 160)}`)
      results.push(r)
      return
    }
    r.proposed = true
    created.approvalIds.push(id)

    // 2) assert pending + hash
    const { data: pend } = await db
      .from("approval_queue")
      .select("status, params_hash")
      .eq("id", id)
      .single()
    r.pending = pend?.status === "pending"
    r.hashPresent = typeof pend?.params_hash === "string" && pend.params_hash.length === 64
    if (!r.pending) r.issues.push(`expected pending, got ${pend?.status}`)
    if (!r.hashPresent) r.issues.push(`params_hash missing/short`)

    // 3) approve
    const { data: appr } = await db
      .from("approval_queue")
      .update({ status: "approved", decided_by: "antonio", decided_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .select("id")
    r.approved = Array.isArray(appr) && appr.length === 1
    if (!r.approved) r.issues.push("approve UPDATE did not affect exactly 1 row")

    // 4) execute via HTTP
    const exec = await execViaHttp(id)
    r.httpOk = exec.ok
    if (!exec.ok) r.issues.push(`executor HTTP not ok: ${JSON.stringify(exec.body).slice(0, 200)}`)

    // 5) assert terminal status + result + callback
    const { data: fin } = await db
      .from("approval_queue")
      .select("status, result, error_text")
      .eq("id", id)
      .single()
    r.finalStatus = fin?.status ?? "(none)"
    if (r.finalStatus !== c.expected) {
      r.issues.push(`expected ${c.expected}, got ${r.finalStatus} (err: ${fin?.error_text ?? "—"})`)
    }

    const { data: cb } = await db
      .from("agent_messages")
      .select("id, context_json, reply")
      .eq("context_json->>approval_id", id)
    r.callback = Array.isArray(cb) && cb.length >= 1
    if (!r.callback) r.issues.push("no outcome callback in agent_messages")

    // 6) tool-specific effect verification
    if (c.verify) {
      const issues = await c.verify(fin?.result)
      r.effectOk = issues.length === 0
      r.issues.push(...issues)
    }
  } catch (err) {
    r.issues.push(`exception: ${err instanceof Error ? err.message : String(err)}`)
  }

  results.push(r)
}

async function setupFixtures(): Promise<void> {
  // throwaway contact under QA Alpha
  const { data: contact, error: cErr } = await db
    .from("contacts")
    .insert({ full_name: `QA S3 Tester ${RUN}` })
    .select("id")
    .single()
  if (cErr) throw new Error(`fixture contact insert failed: ${cErr.message}`)
  created.contactId = contact.id
  await db.from("account_contacts").insert({ account_id: ACCT, contact_id: contact.id, role: "Test" })

  // throwaway service under QA Alpha
  const { data: svc, error: sErr } = await db
    .from("services")
    .insert({ account_id: ACCT, service_name: `QA S3 Service ${RUN}`, service_type: "Support", status: "Not Started" })
    .select("id")
    .single()
  if (sErr) throw new Error(`fixture service insert failed: ${sErr.message}`)
  created.serviceId = svc.id

  // throwaway active service_delivery for the advance_service_stage cascade test.
  // Direct insert (NOT createSD) so no workflow-dispatch side effects fire.
  // Banking Fintech has pipeline_stages: stage_order 1 (Data Collection, 1 auto_task)
  // → 2 (Application Submitted, 1 auto_task).
  const { data: del, error: dErr } = await db
    .from("service_deliveries")
    .insert({
      account_id: ACCT,
      service_name: `QA S3 Delivery ${RUN}`,
      service_type: "Banking Fintech",
      status: "active",
      stage: "Data Collection",
      stage_order: 1,
    })
    .select("id")
    .single()
  if (dErr) throw new Error(`fixture delivery insert failed: ${dErr.message}`)
  created.deliveryId = del.id

  // capture QA Alpha notes so update_account_notes can be reverted
  const { data: acct } = await db.from("accounts").select("notes").eq("id", ACCT).single()
  originalAccountNotes = acct?.notes ?? null
}

async function cleanup(): Promise<void> {
  console.log("\n🧹 cleanup…")
  // auto-tasks created by advance_service_stage (by delivery_id) + the delivery
  if (created.deliveryId) {
    await db.from("tasks").delete().eq("delivery_id", created.deliveryId)
    await db.from("service_deliveries").delete().eq("id", created.deliveryId)
  }
  // tasks created (create_task + any auto-tasks)
  if (created.taskIds.length) await db.from("tasks").delete().in("id", created.taskIds)
  // conversations
  if (created.conversationIds.length) await db.from("conversations").delete().in("id", created.conversationIds)
  // memory
  for (const k of created.memoryKeys) await db.from("agent_memory").delete().eq("scope", "global").eq("key", k)
  // restore account notes
  await db.from("accounts").update({ notes: originalAccountNotes }).eq("id", ACCT)
  // throwaway service + contact
  if (created.serviceId) await db.from("services").delete().eq("id", created.serviceId)
  if (created.contactId) {
    await db.from("account_contacts").delete().eq("contact_id", created.contactId)
    await db.from("contacts").delete().eq("id", created.contactId)
  }
  // outcome callbacks for our approvals
  if (created.approvalIds.length) {
    for (const id of created.approvalIds) {
      await db.from("agent_messages").delete().eq("context_json->>approval_id", id)
    }
    // approval_queue rows
    await db.from("approval_queue").delete().in("id", created.approvalIds)
  }
  console.log("🧹 cleanup done.")
}

async function main() {
  console.log(`\n🚦 Approval-rail S3 E2E — run ${RUN} — sandbox ${SANDBOX_REF}\n`)

  // dev server health check
  const health = await execViaHttp("00000000-0000-0000-0000-000000000000")
  if (!health.ok) {
    console.error(`✋ Dev server not reachable / unauthorized at ${BASE}. Body:`, health.body)
    process.exit(1)
  }
  console.log("✅ dev server reachable + executor authorized\n")

  await setupFixtures()
  console.log(`fixtures: contact=${created.contactId} service=${created.serviceId} acct=${ACCT}\n`)

  // ── 1. create_task (also proves Part-1 normalization: medium→Normal, "follow up"→Follow-up) ──
  await runCase({
    tool: "create_task",
    params: { task_title: `[QA S3] task ${RUN}`, account_id: ACCT, priority: "medium", category: "follow up" },
    expected: "executed",
    verify: async (result) => {
      const issues: string[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const task = (result as any)?.task
      if (!task?.id) { issues.push("no task in result"); return issues }
      created.taskIds.push(task.id)
      if (task.priority !== "Normal") issues.push(`priority not normalized: ${task.priority}`)
      // re-read category from DB (not in returned shape)
      const { data } = await db.from("tasks").select("category, status").eq("id", task.id).single()
      if (data?.category !== "Follow-up") issues.push(`category not normalized: ${data?.category}`)
      if (data?.status !== "To Do") issues.push(`status: ${data?.status}`)
      return issues
    },
  })

  const createdTaskId = created.taskIds[0]

  // ── 2. update_task (status normalization: "in progress"→In Progress) ──
  await runCase({
    tool: "update_task",
    params: { task_id: createdTaskId, status: "in progress", priority: "high", notes: `[QA S3] update ${RUN}` },
    expected: createdTaskId ? "executed" : "failed",
    verify: async (result) => {
      const issues: string[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const task = (result as any)?.task
      if (task?.status !== "In Progress") issues.push(`status not normalized: ${task?.status}`)
      if (task?.priority !== "High") issues.push(`priority not normalized: ${task?.priority}`)
      return issues
    },
  })

  // ── 3. update_account_notes ──
  await runCase({
    tool: "update_account_notes",
    params: { account_id: ACCT, note: `[QA S3] account note ${RUN}` },
    expected: "executed",
    verify: async () => {
      const { data } = await db.from("accounts").select("notes").eq("id", ACCT).single()
      return data?.notes?.includes(`[QA S3] account note ${RUN}`) ? [] : ["note not appended"]
    },
  })

  // ── 4. update_contact ──
  await runCase({
    tool: "update_contact",
    params: { contact_id: created.contactId, notes: `[QA S3] contact note ${RUN}`, phone: "+10000000000" },
    expected: "executed",
    verify: async () => {
      const { data } = await db.from("contacts").select("phone, notes").eq("id", created.contactId).single()
      const issues: string[] = []
      if (data?.phone !== "+10000000000") issues.push(`phone not set: ${data?.phone}`)
      if (!data?.notes?.includes(`[QA S3] contact note ${RUN}`)) issues.push("note not appended")
      return issues
    },
  })

  // ── 5. update_service (status normalization) ──
  await runCase({
    tool: "update_service",
    params: { service_id: created.serviceId, status: "in progress", notes: `[QA S3] svc ${RUN}` },
    expected: "executed",
    verify: async (result) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = (result as any)?.service
      return svc?.status === "In Progress" ? [] : [`status not normalized: ${svc?.status}`]
    },
  })

  // ── 6. advance_service_stage (cascade: advances stage + creates auto-tasks) ──
  await runCase({
    tool: "advance_service_stage",
    params: { service_id: created.deliveryId, notes: `[QA S3] advance ${RUN}` },
    expected: "executed",
    verify: async (result) => {
      const issues: string[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = result as any
      if (res?.new_stage !== "Application Submitted") issues.push(`new_stage: ${res?.new_stage}`)
      // delivery row advanced
      const { data: del } = await db.from("service_deliveries").select("stage, stage_order").eq("id", created.deliveryId).single()
      if (del?.stage_order !== 2) issues.push(`delivery stage_order not advanced: ${del?.stage_order}`)
      // cascade: auto-task(s) created for this delivery
      const { data: autoTasks } = await db.from("tasks").select("id").eq("delivery_id", created.deliveryId)
      if (!autoTasks || autoTasks.length < 1) issues.push("no cascade auto-task created")
      else if (!Array.isArray(res?.tasks_created) || res.tasks_created.length < 1) issues.push("tasks_created not reported in result")
      return issues
    },
  })

  // ── 7. send_email (SANDBOX mock → executed, NO real email) ──
  await runCase({
    tool: "send_email",
    params: { to: "uxio74@gmail.com", subject: `[QA S3] rail test ${RUN}`, body: "QA automated test — please ignore." },
    expected: "executed",
    verify: async (result) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (result as any)?.message ?? ""
      return msg.includes("Email sent") ? [] : [`unexpected result: ${JSON.stringify(result).slice(0, 120)}`]
    },
  })

  // ── 8. drive_move (SANDBOX mock → executed) ──
  await runCase({
    tool: "drive_move",
    params: { file_id: `qa-fake-file-${RUN}`, target_folder_id: `qa-fake-folder-${RUN}` },
    expected: "executed",
    verify: async (result) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const file = (result as any)?.file
      return file?.id === `qa-fake-file-${RUN}` ? [] : [`unexpected mock result: ${JSON.stringify(result).slice(0, 120)}`]
    },
  })

  // ── 9. drive_upload_file (SANDBOX mock; real source fetch via data: URL) ──
  await runCase({
    tool: "drive_upload_file",
    params: {
      file_name: `[QA S3] upload ${RUN}.txt`,
      folder_id: `qa-fake-folder-${RUN}`,
      source_url: "data:text/plain;base64,UUEgUzMgdGVzdA==", // "QA S3 test"
    },
    expected: "executed",
    verify: async (result) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fid = (result as any)?.file_id
      return fid === "sandbox-mock" ? [] : [`unexpected upload result: ${JSON.stringify(result).slice(0, 120)}`]
    },
  })

  // ── 10. gmail_get_attachments save_to_drive (gmailGet NOT mocked → fake id → controlled failure) ──
  await runCase({
    tool: "gmail_get_attachments",
    params: { message_id: `qa-fake-msg-${RUN}`, save_to_drive: true, drive_folder_id: `qa-fake-folder-${RUN}` },
    expected: "failed",
    verify: async () => [],
  })

  // ── 11. log_conversation (channel normalization: whatsapp→WhatsApp) ──
  await runCase({
    tool: "log_conversation",
    params: { account_id: ACCT, contact_id: created.contactId, channel: "whatsapp", topic: `[QA S3] conv ${RUN}`, direction: "inbound" },
    expected: "executed",
    verify: async (result) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conv = (result as any)?.conversation
      if (!conv?.id) return ["no conversation in result"]
      created.conversationIds.push(conv.id)
      const { data } = await db.from("conversations").select("channel").eq("id", conv.id).single()
      return data?.channel === "WhatsApp" ? [] : [`channel not normalized: ${data?.channel}`]
    },
  })

  // ── 12. save_memory ──
  {
    const key = `qa_s3_rail_${RUN}`
    created.memoryKeys.push(key)
    await runCase({
      tool: "save_memory",
      params: { key, content: `[QA S3] memory ${RUN}`, scope: "global" },
      expected: "executed",
      verify: async () => {
        const { data } = await db.from("agent_memory").select("content").eq("scope", "global").eq("key", key).single()
        return data?.content?.includes(`[QA S3] memory ${RUN}`) ? [] : ["memory not saved"]
      },
    })
  }

  // ── report ──
  console.log("\n══════════════════════ PASS/FAIL MATRIX ══════════════════════")
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n)
  console.log(pad("TOOL", 24) + pad("PROP", 5) + pad("PEND", 5) + pad("HASH", 5) + pad("APPR", 5) + pad("HTTP", 5) + pad("STATUS", 10) + pad("EXP", 10) + pad("CB", 4) + pad("EFFECT", 8) + "VERDICT")
  let allPass = true
  for (const r of results) {
    const statusMatch = r.finalStatus === r.expectedStatus
    const effectPass = r.effectOk === null ? true : r.effectOk
    const pass = r.proposed && r.pending && r.hashPresent && r.approved && r.httpOk && statusMatch && r.callback && effectPass
    if (!pass) allPass = false
    console.log(
      pad(r.tool, 24) +
      pad(r.proposed ? "✓" : "✗", 5) +
      pad(r.pending ? "✓" : "✗", 5) +
      pad(r.hashPresent ? "✓" : "✗", 5) +
      pad(r.approved ? "✓" : "✗", 5) +
      pad(r.httpOk ? "✓" : "✗", 5) +
      pad(r.finalStatus, 10) +
      pad(r.expectedStatus, 10) +
      pad(r.callback ? "✓" : "✗", 4) +
      pad(r.effectOk === null ? "n/a" : r.effectOk ? "✓" : "✗", 8) +
      (pass ? "PASS" : "FAIL")
    )
    if (r.issues.length) for (const i of r.issues) console.log(`        ↳ ${i}`)
  }
  console.log("══════════════════════════════════════════════════════════════")
  console.log(allPass ? "\n✅ ALL CASES PASS\n" : "\n❌ SOME CASES FAILED (see ↳ notes)\n")
}

main()
  .catch((err) => {
    console.error("FATAL:", err)
  })
  .finally(async () => {
    await cleanup()
    process.exit(0)
  })
