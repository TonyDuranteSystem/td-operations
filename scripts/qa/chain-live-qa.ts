/* eslint-disable no-console -- QA harness; console output IS the product */
/**
 * Phase 3R live QA — self-healing chunked AI chains, against the SANDBOX DB.
 *
 * Exercises the REAL handler + watchdog functions (no HTTP needed — the chain
 * protocol lives in the handler/watchdog layer) with a mocked AI fetch, tight
 * deadlines, and a seeded workspace:
 *   1. relay: a tight-deadline chunk stops cleanly, inserts EXACTLY ONE
 *      continuation (self excluded from the guard), runner completes it;
 *   2. chain completion: driving the queue like the worker does finishes all
 *      candidates across ≥3 chunks; per-chunk run records written;
 *   3. circuit breaker: an all-batches-fail chunk halts (ok:false), inserts
 *      NO continuation;
 *   4. watchdog: revives the halted chain after backoff (auto_retry+1), is a
 *      no-op while a job is live, and never double-inserts;
 *   5. exhaustion: ladder spent → action_log ai_chain_exhausted exactly once.
 *
 * Run: npx tsx --env-file=.env.local scripts/qa/chain-live-qa.ts
 * Seeds an isolated workspace; deletes it at the end. The AI fetch is mocked
 * via aiOptions.fetchImpl so no ANTHROPIC key/cost is involved.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { handleRecategorizeWorkspaceAi } from "@/lib/jobs/handlers/recategorize-workspace-ai"
import { runChainWatchdog, chainStateForScope } from "@/lib/jobs/chain-watchdog"
import type { Job } from "@/lib/jobs/queue"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name} ${detail}`) }
  else { fail++; console.log(`  ❌ FAIL ${name} ${detail}`) }
}

/** SELECTIVE fetch mock: only Anthropic calls are intercepted — Supabase and
 *  everything else pass through to the real fetch (patching everything breaks
 *  the DB client, as round 1 of this harness proved). */
const realFetch = global.fetch
function anthropicMock(mode: "ok" | "fail"): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url as RequestInfo, init)
    if (mode === "fail") return new Response("boom", { status: 500 })
    const body = JSON.parse((init as { body?: string })?.body ?? "{}")
    const ids: string[] = ((body.messages[0].content as string).match(/[0-9a-f-]{36}/g) ?? [])
    return new Response(JSON.stringify({
      content: [{ type: "tool_use", name: "suggest_categories", input: { suggestions: Array.from(new Set(ids)).map(id => ({ id, category: "expense", subcategory: "software", confidence: "high", lean: "business", bucket: "other" })) } }],
    }), { status: 200 })
  }) as unknown as typeof fetch
}

async function claimScope(wsId: string): Promise<Job | null> {
  // Deterministic claim for the harness (the RPC claims globally; we only want
  // OUR scope). Mimics claim semantics: pending → processing.
  const { data } = await db.from("job_queue").select("*").eq("job_type", "recategorize_workspace_ai")
    .eq("related_entity_id", wsId).eq("status", "pending").order("created_at").limit(1)
  if (!data || data.length === 0) return null
  await db.from("job_queue").update({ status: "processing", started_at: new Date().toISOString() }).eq("id", data[0].id)
  return { ...data[0], status: "processing" } as Job
}
async function finish(job: Job, result: { ok?: boolean }) {
  await db.from("job_queue").update({
    status: result.ok === false ? "failed" : "completed",
    completed_at: new Date().toISOString(),
    result,
  }).eq("id", job.id)
}

async function main() {
  console.log("\n== PHASE 3R CHAIN LIVE QA (sandbox DB) ==")
  const { data: ws } = await db.from("pnl_workspaces")
    .insert({ tax_year: 2025, entity_type: "MMLLC", company_name: "QA Chain LLC", created_by: "qa-3r", generated_at: new Date().toISOString() })
    .select("id").single()
  const WS = ws.id as string
  console.log(`workspace: ${WS}`)
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "qa-mock-key"

  try {
    // 130 candidate rows = 4 batches of 40/40/40/10.
    const rows = Array.from({ length: 130 }, (_, i) => ({
      workspace_id: WS, tax_year: 2025, transaction_date: "2025-03-03", description: `QA merchant ${i}`,
      counterparty: "", amount: -12, currency: "USD", bank_name: "Mercury", account_type: "checking",
      transaction_ref: `qa3r-${i}`, category: "uncategorized", subcategory: "", notes: null,
    }))
    await db.from("pnl_workspace_transactions").insert(rows)

    // ---- 1+2: relay + completion. Tight per-invocation deadline = 1 batch/chunk. ----
    global.fetch = anthropicMock("ok")
    await db.from("job_queue").insert({
      job_type: "recategorize_workspace_ai", payload: { workspace_id: WS, chunk_index: 0, auto_retry: 0 },
      priority: 8, related_entity_type: "pnl_workspace", related_entity_id: WS, created_by: "qa-3r",
    })
    let chunks = 0
    for (; chunks < 10; chunks++) {
      const job = await claimScope(WS)
      if (!job) break
      // deadline = now + allowance + ~1s → exactly one batch fits per chunk
      const r = await handleRecategorizeWorkspaceAi(job, { deadlineAt: Date.now() + 101_000 })
      await finish(job, r)
      if (r.ok === false) break
    }
    ok("chain relayed across multiple chunks", chunks >= 3, `chunks=${chunks}`)
    const { count: labeled } = await db.from("pnl_workspace_transactions").select("id", { count: "exact", head: true })
      .eq("workspace_id", WS).like("notes", "ai:high%")
    ok("all 130 candidates labeled by the chain", labeled === 130, `labeled=${labeled}`)
    const { count: liveAfter } = await db.from("job_queue").select("id", { count: "exact", head: true })
      .eq("job_type", "recategorize_workspace_ai").eq("related_entity_id", WS).in("status", ["pending", "processing"])
    ok("no dangling jobs after completion", liveAfter === 0)
    const { count: runRecords } = await db.from("ai_categorization_runs").select("id", { count: "exact", head: true }).eq("workspace_id", WS)
    ok("one run record per chunk", (runRecords ?? 0) === chunks, `records=${runRecords} chunks=${chunks}`)
    const state1 = await chainStateForScope({ jobType: "recategorize_workspace_ai", workspaceId: WS })
    ok("chain state = idle after completion", state1.state === "idle", state1.state)

    // ---- 3: circuit breaker — fresh candidates, dead API. ----
    const rows2 = Array.from({ length: 50 }, (_, i) => ({
      workspace_id: WS, tax_year: 2025, transaction_date: "2025-04-01", description: `QA dead ${i}`,
      counterparty: "", amount: -9, currency: "USD", bank_name: "Mercury", account_type: "checking",
      transaction_ref: `qa3r-dead-${i}`, category: "uncategorized", subcategory: "", notes: null,
    }))
    await db.from("pnl_workspace_transactions").insert(rows2)
    global.fetch = anthropicMock("fail")
    await db.from("job_queue").insert({
      job_type: "recategorize_workspace_ai", payload: { workspace_id: WS, chunk_index: 0, auto_retry: 0 },
      priority: 8, related_entity_type: "pnl_workspace", related_entity_id: WS, created_by: "qa-3r",
    })
    const deadJob = await claimScope(WS)
    const deadResult = await handleRecategorizeWorkspaceAi(deadJob!, { deadlineAt: Date.now() + 250_000 })
    await finish(deadJob!, deadResult)
    ok("zero-progress chunk halts with ok:false", deadResult.ok === false)
    const { count: liveAfterHalt } = await db.from("job_queue").select("id", { count: "exact", head: true })
      .eq("job_type", "recategorize_workspace_ai").eq("related_entity_id", WS).in("status", ["pending", "processing"])
    ok("halted chunk inserts NO continuation", liveAfterHalt === 0)

    // ---- 4: watchdog revival. First tick: too early (backoff 15m) → no-op. ----
    const wd1 = await runChainWatchdog(Date.now())
    ok("watchdog waits out the backoff (no premature re-enqueue)", !wd1.reEnqueued.some(s => s.includes(WS)))
    // Time-travel: pretend it's 16 minutes later.
    const wd2 = await runChainWatchdog(Date.now() + 16 * 60_000)
    ok("watchdog revives the chain after backoff", wd2.reEnqueued.some(s => s.includes(WS)), JSON.stringify(wd2))
    const { data: revived } = await db.from("job_queue").select("payload").eq("job_type", "recategorize_workspace_ai")
      .eq("related_entity_id", WS).eq("status", "pending")
    ok("revived job carries auto_retry=1", revived?.[0]?.payload?.auto_retry === 1, JSON.stringify(revived?.[0]?.payload))
    const wd3 = await runChainWatchdog(Date.now() + 17 * 60_000)
    ok("watchdog is a no-op while a job is live (no double insert)", !wd3.reEnqueued.some(s => s.includes(WS)))

    // ---- 5: exhaustion — fail the revived job at the top of the ladder. ----
    const revJob = await claimScope(WS)
    // Simulate ladder spent: overwrite auto_retry to 5 then fail it.
    await db.from("job_queue").update({ payload: { workspace_id: WS, chunk_index: 0, auto_retry: 5 } }).eq("id", revJob!.id)
    await finish({ ...revJob!, payload: { workspace_id: WS, chunk_index: 0, auto_retry: 5 } } as Job, { ok: false })
    const wd4 = await runChainWatchdog(Date.now() + 20 * 60_000)
    ok("ladder spent → exhaustion alert fired", wd4.exhaustedAlerts.some(s => s.includes(WS)), JSON.stringify(wd4))
    const wd5 = await runChainWatchdog(Date.now() + 25 * 60_000)
    ok("exhaustion alert throttled (once per event)", !wd5.exhaustedAlerts.some(s => s.includes(WS)))
    const state2 = await chainStateForScope({ jobType: "recategorize_workspace_ai", workspaceId: WS })
    ok("chain state = exhausted for the GETs", state2.state === "exhausted", state2.state)
  } finally {
    global.fetch = realFetch
    await db.from("job_queue").delete().eq("related_entity_id", WS)
    await db.from("action_log").delete().eq("action_type", "ai_chain_exhausted").like("summary", `%${WS}%`)
    await db.from("pnl_workspaces").delete().eq("id", WS)
    console.log("cleanup: workspace + jobs deleted")
  }

  console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error("QA FAILED:", e); process.exit(1) })
