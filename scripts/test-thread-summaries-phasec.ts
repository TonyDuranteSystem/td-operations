/* eslint-disable no-console -- dev-only sandbox QA driver for Phase C, never shipped to runtime */
/* eslint-disable no-restricted-syntax -- throwaway test fixtures + cleanup; intentionally raw writes, not production code paths */
/**
 * Phase C real-DB E2E (sandbox) — Hermes ↔ Claude thread intelligence.
 *
 * Mocked unit tests can't catch NOT-NULL / wrong-column / array-filter DB errors
 * (the Slice 3 / Phase B lesson in docs/systems/agent-bridge.md). This drives the
 * REAL thread-summary + thread-context functions against the sandbox Postgres and
 * asserts:
 *   - createThreadSummary satisfies thread_type NOT NULL + is idempotent on the PK,
 *   - resolveThread writes resolved_at/outcome/summary_text WITHOUT an updated_at
 *     column (there is none — a stray write would 42703),
 *   - searchThreads' `.contains("tags", [...])` array filter actually works in PG,
 *   - buildThreadContext reads agent_messages by thread_id and labels turns.
 * Then it cleans up everything it created.
 *
 * Run: npx tsx scripts/test-thread-summaries-phasec.ts
 */

import { config as dotenvConfig } from "dotenv"
dotenvConfig({ path: ".env.local" })

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  createThreadSummary,
  resolveThread,
  getThreadSummary,
  searchThreads,
} from "@/lib/ai-agent/thread-summaries"
import { buildThreadContext } from "@/lib/ai-agent/thread-context"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`, extra ?? "") }
}

// Stable-but-unique ids for this run. HEX only (UUID last segment must be hex).
const RUN = Date.now().toString(16)
const HEX12 = RUN.padStart(12, "0").slice(-12)
const T1 = `00000000-0000-4000-8000-${HEX12}`
const T2 = `00000000-0000-4000-8001-${HEX12}`

async function main() {
  const ref = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
  if (!ref.includes("xjcxlmlpeywtwkhstjlw")) {
    console.error(`REFUSING: not sandbox (NEXT_PUBLIC_SUPABASE_URL=${ref}).`)
    process.exit(1)
  }
  console.log(`Phase C thread-summaries E2E — sandbox, run ${RUN}\n`)

  try {
    // 1. create (thread_type NOT NULL satisfied; unknown type coerced)
    const created = await createThreadSummary(T1, "bug_report", "Tax return mismatch E2E")
    check("createThreadSummary inserts a row", created?.thread_id === T1, created)
    check("thread_type persisted", created?.thread_type === "bug_report")
    check("title persisted", created?.title === "Tax return mismatch E2E")

    const coerced = await createThreadSummary(T2, "garbage_type", "Internal ops E2E")
    check("unknown thread_type coerced to investigation", coerced?.thread_type === "investigation")

    // 2. idempotent create on PK
    const dup = await createThreadSummary(T1, "client_audit", "different title")
    check("duplicate create returns existing row (idempotent)", dup?.title === "Tax return mismatch E2E" && dup?.thread_type === "bug_report")

    // 3. tag the rows directly so we can exercise the array `.contains` filter
    await db.from("thread_summaries").update({ tags: ["tax", "mismatch", `run-${RUN}`] }).eq("thread_id", T1)
    await db.from("thread_summaries").update({ tags: [`run-${RUN}`] }).eq("thread_id", T2)

    // 4. resolveThread — MUST NOT touch a (nonexistent) updated_at column
    const resolved = await resolveThread(T1, "investigation_complete", "The 1120 totals did not reconcile; root cause traced.")
    check("resolveThread stamped resolved_at", !!resolved?.resolved_at, resolved)
    check("resolveThread set outcome", resolved?.outcome === "investigation_complete")
    check("resolveThread set summary_text", (resolved?.summary_text ?? "").startsWith("The 1120 totals"))

    const readBack = await getThreadSummary(T1)
    check("getThreadSummary reads the resolved row", readBack?.outcome === "investigation_complete")
    check("getThreadSummary returns null for absent id", (await getThreadSummary("11111111-1111-4111-8111-111111111111")) === null)

    // 5. searchThreads — free text, type filter, and the array `.contains` tag filter
    const byText = await searchThreads("tax return")
    check("searchThreads free-text matches title", byText.rows.some((r) => r.thread_id === T1))

    const byType = await searchThreads(`run-${RUN}`, { type: "investigation" })
    check("searchThreads type filter narrows", byType.rows.some((r) => r.thread_id === T2) && !byType.rows.some((r) => r.thread_id === T1))

    const byTag = await searchThreads("", { tags: ["mismatch", `run-${RUN}`] })
    check("searchThreads `.contains` tag filter (PG array) works", byTag.rows.length === 1 && byTag.rows[0].thread_id === T1, byTag.rows.map((r) => r.thread_id))

    // 6. buildThreadContext over real agent_messages rows
    const m1 = (await db.from("agent_messages").insert({
      sender: "hermes", recipient: "claude", subject: "ctx1", body: "first directive about the bug", status: "done", reply: "the findings", thread_id: T1,
    }).select("id").single()).data
    const m2 = (await db.from("agent_messages").insert({
      sender: "hermes", recipient: "claude", subject: "ctx2", body: "a follow-up question", status: "pending", thread_id: T1,
    }).select("id").single()).data

    const ctxAll = await buildThreadContext(T1)
    check("buildThreadContext counts both messages", ctxAll.messageCount === 2, ctxAll.messageCount)
    check("buildThreadContext labels first hermes as Antonio", ctxAll.text.includes("Antonio directed: first directive"))
    check("buildThreadContext labels later hermes as Hermes", ctxAll.text.includes("Hermes said: a follow-up"))
    check("buildThreadContext renders the reply as Claude", ctxAll.text.includes("Claude said: the findings"))

    const ctxExcl = await buildThreadContext(T1, { excludeMessageId: m2?.id })
    check("excludeMessageId drops the current turn", ctxExcl.messageCount === 1 && !ctxExcl.text.includes("a follow-up"))

    // cleanup agent_messages
    await db.from("agent_messages").delete().in("id", [m1?.id, m2?.id].filter(Boolean))
  } finally {
    // cleanup thread_summaries
    await db.from("thread_summaries").delete().in("thread_id", [T1, T2])
    console.log("\n🧹 cleanup done")
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
