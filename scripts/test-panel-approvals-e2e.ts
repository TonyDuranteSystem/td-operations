/* eslint-disable no-console -- dev-only QA driver, never shipped to runtime */
/* eslint-disable no-restricted-syntax -- throwaway fixtures + cleanup; intentionally raw writes */
/**
 * In-panel confirmation — end-to-end against a REAL database.
 *
 * Unit tests prove the gates in isolation. They cannot prove the two things that only
 * exist at runtime: that a confirmed action actually runs and changes something, and that
 * two simultaneous clicks produce ONE execution rather than two. The second is the whole
 * reason the guard is an atomic compare-and-set instead of a read-then-write, and it is
 * unprovable by reading code — it needs two real requests racing on a real row.
 *
 * Runs against the worktree's own disposable local stack. Guarded below so it can never
 * touch sandbox or production: it creates rows and executes real tools.
 *
 *   npx tsx scripts/test-panel-approvals-e2e.ts
 */

import { config as dotenvConfig } from "dotenv"
dotenvConfig({ path: ".env.local" })

// ── Guard: local disposable stack ONLY. This script executes real actions. ──
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
  console.error(`✋ Refusing to run: this driver creates and EXECUTES real actions, so it only runs against the local stack. Saw: ${url}`)
  process.exit(1)
}

import { proposeAction } from "@/lib/ai-agent/worker-tools"
import { loadPendingActionCards, confirmPendingAction, mayBeConfirmedInPanel } from "@/lib/ai-agent/panel-approvals"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
const created: string[] = []
let failures = 0

function check(name: string, pass: boolean, detail = "") {
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!pass) failures++
}

function idFrom(proposeOutput: string): string | null {
  const m = proposeOutput.match(/^PendingAction:\s+([0-9a-f-]{36})$/m)
  return m ? m[1] : null
}

async function main() {
  process.env.WORKER_PANEL_APPROVALS = "true"
  const stamp = Date.now()

  // ── 1. Propose from a panel → a real frozen row ──────────────────────────
  const title = `QA Test panel-approval ${stamp}`
  const out = await proposeAction(
    { tool_name: "create_task", params: { task_title: title, description: "E2E driver", priority: "Normal" } },
    { panelSurface: "dashboard" },
  )
  const id = idFrom(out)
  check("propose returns a PendingAction marker", Boolean(id), id ?? out.slice(0, 120))
  if (!id) return
  created.push(id)

  const { data: row } = await db.from("approval_queue").select("status, params_hash, tool_name, params").eq("id", id).maybeSingle()
  check("row is pending with an integrity hash", row?.status === "pending" && Boolean(row?.params_hash), `status=${row?.status}`)
  check("NOTHING executed at propose time", row?.executed_at == null)

  // ── 2. The card is built from the frozen row, not the model's text ───────
  const cards = await loadPendingActionCards([id])
  check("card loads for the pending action", cards.length === 1)
  check("card shows the REAL frozen values", cards[0]?.params?.task_title === title, String(cards[0]?.params?.task_title))
  check("card has a readable title", cards[0]?.title === "Create CRM task", cards[0]?.title)

  // ── 3. THE DOUBLE-CLICK RACE — the behaviour only a live run can prove ───
  // Two confirms fired concurrently on the same row, as a double-click does.
  const [a, b] = await Promise.all([
    confirmPendingAction(id, "qa-driver@tonydurante.us"),
    confirmPendingAction(id, "qa-driver@tonydurante.us"),
  ])
  const winners = [a, b].filter((r) => r.ok)
  const losers = [a, b].filter((r) => !r.ok)
  check("exactly ONE of two simultaneous clicks wins", winners.length === 1, `winners=${winners.length}`)
  check("the loser is told plainly, not silently ignored", losers.length === 1 && /no longer waiting/i.test((losers[0] as { error: string }).error ?? ""))

  // ── 4. It actually ran, and ran ONCE ─────────────────────────────────────
  const { data: after } = await db.from("approval_queue").select("status, executed_at").eq("id", id).maybeSingle()
  check("row reached a terminal executed state", after?.status === "executed", `status=${after?.status}`)

  const { data: tasks } = await db.from("tasks").select("id").eq("task_title", title)
  check("the task really exists in the CRM", (tasks?.length ?? 0) >= 1, `found=${tasks?.length ?? 0}`)
  check("created EXACTLY once (no double execution)", tasks?.length === 1, `found=${tasks?.length ?? 0}`)
  for (const t of tasks ?? []) await db.from("tasks").delete().eq("id", t.id)

  // ── 5. A settled card cannot be clicked again ────────────────────────────
  const again = await confirmPendingAction(id, "qa-driver@tonydurante.us")
  check("re-confirming a finished action is refused", again.ok === false)

  // ── 6. Discard runs nothing ──────────────────────────────────────────────
  const dTitle = `QA Test discard ${stamp}`
  const dOut = await proposeAction(
    { tool_name: "create_task", params: { task_title: dTitle, description: "E2E driver", priority: "Normal" } },
    { panelSurface: "dashboard" },
  )
  const dId = idFrom(dOut)
  if (dId) {
    created.push(dId)
    const discarded = await confirmPendingAction(dId, "qa-driver@tonydurante.us", "discard")
    check("discard reports discarded", discarded.ok === true && discarded.status === "discarded")
    const { data: dRow } = await db.from("approval_queue").select("status").eq("id", dId).maybeSingle()
    check("discarded row is rejected, never executed", dRow?.status === "rejected", `status=${dRow?.status}`)
    const { data: dTasks } = await db.from("tasks").select("id").eq("task_title", dTitle)
    check("discard created NOTHING", (dTasks?.length ?? 0) === 0, `found=${dTasks?.length ?? 0}`)
  } else {
    check("discard fixture proposed", false, dOut.slice(0, 120))
  }

  // ── 7. A client-facing send can never become a card ──────────────────────
  // BOTH naming schemes reach this gate. send_email is the agent-tool name and was the
  // one that slipped through until the 2026-07-20 live run.
  for (const sendTool of ["gmail_send", "send_email"]) {
    const sendOut = await proposeAction(
      { tool_name: sendTool, params: { to: "nobody@example.com", subject: "x", body: "y" } },
      { panelSurface: "dashboard" },
    )
    check(`${sendTool}: refused at propose time`, sendOut.startsWith("❌"), sendOut.slice(0, 90))
    check(`${sendTool}: left NO queue row`, idFrom(sendOut) === null)
    check(`${sendTool}: gate agrees independently`, mayBeConfirmedInPanel(sendTool).ok === false)
  }

  // ── 8. Audit trail ───────────────────────────────────────────────────────
  const { data: log } = await db.from("action_log").select("actor, summary").eq("record_id", id).limit(5)
  check("the confirmed action is in the audit trail", (log?.length ?? 0) >= 1, `entries=${log?.length ?? 0}`)
  check("the audit names who clicked", /qa-driver@tonydurante\.us/.test(log?.[0]?.actor ?? ""), log?.[0]?.actor ?? "(none)")
}

main()
  .then(async () => {
    for (const id of created) await db.from("approval_queue").delete().eq("id", id)
    console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch(async (err) => {
    for (const id of created) await db.from("approval_queue").delete().eq("id", id)
    console.error("💥 driver threw:", err)
    process.exit(1)
  })
