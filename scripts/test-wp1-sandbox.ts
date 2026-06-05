/* eslint-disable no-console -- dev-only sandbox QA driver for WP1, never shipped to runtime */
/* eslint-disable no-restricted-syntax -- throwaway test fixtures + cleanup; intentionally raw writes, not production code paths */
/**
 * WP1 real-DB E2E (sandbox) — confirmation-code gate + Operating-Agent pull rail.
 *
 * Mocked unit tests can't catch a column-name typo, a NOT-NULL violation, or a
 * real-Postgres filter/JSONB mismatch. This drives the REAL functions + MCP tool
 * handlers against the sandbox and asserts every WP1 behaviour end-to-end:
 *
 *   1. proposeAction mints a 6-digit confirmation_code (verified in the DB row)
 *   2. approval_decide(approve) with the CORRECT code → approved
 *   3. approval_decide(approve) with a WRONG code → error, row stays pending
 *   4. approval_decide(reject) with no code → rejected
 *   5. approval_claim → claims the oldest approved row (passes the hash re-check)
 *   6. approval_claim on an empty lane → "nothing to claim"
 *   7. approval_complete(executed) → row executed + result + executed_by + callback
 *   8. approval_complete(failed)   → row failed + error_text + callback
 *   9. hermes_heartbeat → creates a hermes_instances row (status online)
 *  10. hermes_heartbeat again → updates last_heartbeat on the same row
 *
 * ISOLATION (so the live sandbox approval-executor cron can't interfere):
 *   - All proposals are stamped into a UNIQUE private env lane (wp1-<run>) that
 *     the deployed executor (lane 'production') never scans.
 *   - CRON_SECRET is cleared so approval_decide(approve)'s executor trigger is a
 *     no-op — scenario 5 exercises the PULL path (approval_claim), not the server.
 *
 * Cleans up everything it creates: approval_queue rows (by lane), the CRM-mirror
 * internal_messages (by marker), the agent_messages outcome callbacks (by
 * approval_id), and the hermes_instances heartbeat row.
 *
 * Run: npx tsx scripts/test-wp1-sandbox.ts
 */

import { config as dotenvConfig } from "dotenv"
dotenvConfig({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import { proposeAction } from "@/lib/ai-agent/worker-tools"
import { registerAgentApprovalTools } from "@/lib/mcp/tools/agent-approvals"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? "") }
}

const RUN = Date.now().toString(16)
const MARK = `WP1-E2E-${RUN}`
const TEST_LANE = `wp1-${RUN}`
const EMPTY_LANE = `wp1-empty-${RUN}`
const INSTANCE = `wp1-e2e-${RUN}`
const HB_ID = `wp1-hb-${RUN}`

const createdIds: string[] = []

// Capture every MCP tool handler registered by registerAgentApprovalTools.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const H: Record<string, (args: Record<string, unknown>) => Promise<any>> = {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
registerAgentApprovalTools({ tool: (n: string, _d: string, _s: any, fn: any) => { H[n] = fn } } as any)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(res: any): string {
  return res?.content?.[0]?.text ?? ""
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Propose a create_task in the private lane; return its id + confirmation_code. */
async function propose(suffix: string): Promise<{ id: string; code: string }> {
  const out = await proposeAction({
    tool_name: "create_task",
    params: { task_title: `${MARK} ${suffix}` },
    rationale: MARK,
  })
  const id = out.match(/id=([0-9a-f-]{36})/)?.[1] ?? ""
  const code = out.match(/confirmation_code=(\d{6})/)?.[1] ?? ""
  if (id) createdIds.push(id)
  return { id, code }
}

async function main() {
  const ref = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!ref.includes("xjcxlmlpeywtwkhstjlw")) {
    console.error(`REFUSING: not sandbox (NEXT_PUBLIC_SUPABASE_URL=${ref}).`)
    process.exit(1)
  }

  // Isolation: private lane + no executor trigger.
  process.env.APPROVAL_ENV = TEST_LANE
  delete process.env.CRON_SECRET

  console.log(`WP1 E2E — sandbox, run ${RUN} (lane ${TEST_LANE})\n`)

  try {
    // ── 1) proposeAction mints a 6-digit confirmation_code ───────────────────
    const a = await propose("scenario-1")
    check("proposeAction return includes a 6-digit confirmation_code", /^\d{6}$/.test(a.code), a.code)
    const { data: rowA } = await db
      .from("approval_queue")
      .select("confirmation_code, status, env")
      .eq("id", a.id)
      .maybeSingle()
    check("DB row stores the 6-digit confirmation_code", /^\d{6}$/.test(rowA?.confirmation_code ?? ""), rowA?.confirmation_code)
    check("DB code matches the returned code", rowA?.confirmation_code === a.code)
    check("DB row is pending in the private lane", rowA?.status === "pending" && rowA?.env === TEST_LANE, rowA)

    // ── 2) approve with the CORRECT code → approved ──────────────────────────
    const b = await propose("scenario-2")
    const r2 = await H.approval_decide({ id: b.id, decision: "approve", confirmation_code: b.code })
    check("approve with correct code → 'Approved'", textOf(r2).includes("Approved"), textOf(r2))
    const { data: rowB } = await db.from("approval_queue").select("status").eq("id", b.id).maybeSingle()
    check("DB row B moved to 'approved'", rowB?.status === "approved", rowB)

    // ── 3) approve with a WRONG code → error, stays pending ───────────────────
    const c = await propose("scenario-3")
    const wrong = c.code === "000000" ? "111111" : "000000"
    const r3 = await H.approval_decide({ id: c.id, decision: "approve", confirmation_code: wrong })
    check("approve with wrong code → 'Invalid confirmation code'", textOf(r3).includes("Invalid confirmation code"), textOf(r3))
    const { data: rowC } = await db.from("approval_queue").select("status").eq("id", c.id).maybeSingle()
    check("DB row C stays 'pending' after wrong code (never runs)", rowC?.status === "pending", rowC)

    // ── 4) reject with NO code → rejected ────────────────────────────────────
    const d = await propose("scenario-4")
    const r4 = await H.approval_decide({ id: d.id, decision: "reject", note: `${MARK} not now` })
    check("reject with no code → 'Rejected'", textOf(r4).includes("Rejected"), textOf(r4))
    const { data: rowD } = await db.from("approval_queue").select("status").eq("id", d.id).maybeSingle()
    check("DB row D moved to 'rejected'", rowD?.status === "rejected", rowD)

    // ── 5) approval_claim → claims the oldest approved row (row B) + hash ok ──
    const r5 = await H.approval_claim({ instance_id: INSTANCE })
    const claimedText = textOf(r5)
    let claimed: { id?: string; tool_name?: string; confirmation_code?: string } = {}
    try { claimed = JSON.parse(claimedText) } catch { /* leave empty → fails below */ }
    check("approval_claim returns the oldest approved row (B)", claimed.id === b.id, claimedText)
    check("claimed row carries tool_name + confirmation_code (full row)", claimed.tool_name === "create_task" && /^\d{6}$/.test(claimed.confirmation_code ?? ""), claimed)
    const { data: rowBclaim } = await db.from("approval_queue").select("status, claimed_by").eq("id", b.id).maybeSingle()
    check("DB row B is 'executing' + claimed_by the instance (hash re-check passed)", rowBclaim?.status === "executing" && rowBclaim?.claimed_by === INSTANCE, rowBclaim)

    // ── 6) approval_claim on an EMPTY lane → nothing to claim ─────────────────
    process.env.APPROVAL_ENV = EMPTY_LANE
    const r6 = await H.approval_claim({ instance_id: INSTANCE })
    check("approval_claim on an empty lane → 'Nothing to claim'", textOf(r6).includes("Nothing to claim"), textOf(r6))
    process.env.APPROVAL_ENV = TEST_LANE

    // ── 7) approval_complete(executed) → row updated + callback ──────────────
    const r7 = await H.approval_complete({ id: b.id, status: "executed", result: { ok: true, marker: MARK } })
    check("approval_complete(executed) → 'marked executed'", textOf(r7).includes("marked executed"), textOf(r7))
    const { data: doneB } = await db
      .from("approval_queue")
      .select("status, result, executed_by, executed_at, notification_sent")
      .eq("id", b.id)
      .maybeSingle()
    check("DB row B status = 'executed'", doneB?.status === "executed", doneB?.status)
    check("DB row B result persisted", doneB?.result?.ok === true && doneB?.result?.marker === MARK, doneB?.result)
    check("DB row B executed_by = claiming instance", doneB?.executed_by === INSTANCE, doneB?.executed_by)
    check("DB row B executed_at stamped", !!doneB?.executed_at)
    // NOTE: the patch sets notification_sent=FALSE, but emitApprovalOutcome flips
    // it back to TRUE once the Hermes callback lands (Phase B design — so the
    // retry sweep won't duplicate). The verified END-STATE is therefore TRUE.
    check("DB row B notification_sent = TRUE after emit (callback succeeded)", doneB?.notification_sent === true, doneB?.notification_sent)
    const { data: cbExec } = await db
      .from("agent_messages")
      .select("reply, context_json")
      .eq("context_json->>approval_id", b.id)
      .maybeSingle()
    check("agent_messages callback written for the executed outcome", cbExec?.context_json?.outcome_status === "executed", cbExec?.context_json)

    // ── 8) approval_complete(failed) → row failed + error_text + callback ────
    //   Approve row A, claim it, then complete as failed.
    const r8approve = await H.approval_decide({ id: a.id, decision: "approve", confirmation_code: a.code })
    check("(setup) approve row A with its code", textOf(r8approve).includes("Approved"), textOf(r8approve))
    const r8claim = await H.approval_claim({ instance_id: INSTANCE })
    let claimedA: { id?: string } = {}
    try { claimedA = JSON.parse(textOf(r8claim)) } catch { /* */ }
    check("(setup) approval_claim returns row A", claimedA.id === a.id, textOf(r8claim))
    const r8 = await H.approval_complete({ id: a.id, status: "failed", error_text: `${MARK} simulated failure` })
    check("approval_complete(failed) → 'marked failed'", textOf(r8).includes("marked failed"), textOf(r8))
    const { data: failA } = await db
      .from("approval_queue")
      .select("status, error_text, executed_by, notification_sent")
      .eq("id", a.id)
      .maybeSingle()
    check("DB row A status = 'failed'", failA?.status === "failed", failA?.status)
    check("DB row A error_text persisted", (failA?.error_text ?? "").includes("simulated failure"), failA?.error_text)
    check("DB row A executed_by = claiming instance", failA?.executed_by === INSTANCE, failA?.executed_by)
    const { data: cbFail } = await db
      .from("agent_messages")
      .select("context_json")
      .eq("context_json->>approval_id", a.id)
      .maybeSingle()
    check("agent_messages callback written for the failed outcome", cbFail?.context_json?.outcome_status === "failed", cbFail?.context_json)

    // ── 9) hermes_heartbeat creates a row ────────────────────────────────────
    const r9 = await H.hermes_heartbeat({ instance_id: HB_ID })
    const hb9 = JSON.parse(textOf(r9))
    check("hermes_heartbeat returns ok:true + instance_id", hb9.ok === true && hb9.instance_id === HB_ID, hb9)
    const { data: inst1 } = await db
      .from("hermes_instances")
      .select("instance_id, status, last_heartbeat")
      .eq("instance_id", HB_ID)
      .maybeSingle()
    check("hermes_instances row created with status 'online'", inst1?.instance_id === HB_ID && inst1?.status === "online", inst1)
    const firstBeat = inst1?.last_heartbeat

    // ── 10) hermes_heartbeat updates last_heartbeat on the same row ──────────
    await sleep(1100) // guarantee a distinct timestamp
    await H.hermes_heartbeat({ instance_id: HB_ID })
    const { data: insts } = await db.from("hermes_instances").select("instance_id, last_heartbeat").eq("instance_id", HB_ID)
    check("still exactly ONE row for the instance (upsert, not insert)", (insts ?? []).length === 1, (insts ?? []).length)
    const secondBeat = (insts ?? [])[0]?.last_heartbeat
    check("last_heartbeat advanced on the second beat", !!secondBeat && !!firstBeat && secondBeat > firstBeat, { firstBeat, secondBeat })
  } finally {
    // Cleanup — private lanes, CRM-mirror messages, outcome callbacks, heartbeat.
    await db.from("approval_queue").delete().eq("env", TEST_LANE)
    await db.from("approval_queue").delete().eq("env", EMPTY_LANE)
    await db.from("internal_messages").delete().like("message", `%${MARK}%`)
    for (const id of createdIds) {
      await db.from("agent_messages").delete().eq("context_json->>approval_id", id)
    }
    await db.from("hermes_instances").delete().eq("instance_id", HB_ID)
    console.log("\n🧹 cleanup done")
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
