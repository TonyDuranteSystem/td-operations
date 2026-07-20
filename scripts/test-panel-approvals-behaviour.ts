/* eslint-disable no-console -- dev-only QA driver, never shipped to runtime */
/* eslint-disable no-restricted-syntax -- restores the fixture account's notes after the run; a throwaway revert on the local disposable stack, not a production write path */
/**
 * THE TEST THAT MATTERS: does the assistant actually CHOOSE to offer a card?
 *
 * The other driver proves the machinery — freeze, click, one execution, refusals. It says
 * nothing about whether the assistant ever reaches for it. That distinction is the whole
 * history of this job: the PDF tool worked and it dropped the link; the tool existed and it
 * invented a fake way to make files; the team channel existed and it pointed at Slack.
 * Five times the plumbing was fine and the model didn't use it.
 *
 * So this asks a real question, the way a staff member would, and reports what came back:
 * a card, or another paragraph of instructions for a human to carry out.
 *
 * Local disposable stack only. Model key supplied per-run, never written to .env.local.
 *
 *   ANTHROPIC_API_KEY=... npx tsx scripts/test-panel-approvals-behaviour.ts
 */

import { config as dotenvConfig } from "dotenv"
dotenvConfig({ path: ".env.local" })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (!url.includes("127.0.0.1") && !url.includes("localhost")) {
  console.error(`✋ Local stack only. Saw: ${url}`)
  process.exit(1)
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("✋ ANTHROPIC_API_KEY must be supplied for this run.")
  process.exit(1)
}

import { callWorker } from "@/lib/ai-agent/worker-tools"
import { buildWorkerSurfacePrompt } from "@/lib/ai-agent/inbox-worker-prompt"
import { panelApprovalsEnabledFor, loadPendingActionCards } from "@/lib/ai-agent/panel-approvals"
import { buildClientCardSuffix } from "@/lib/ai-agent/client-card"
import { buildClientScope } from "@/lib/ai-agent/client-scope"
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

// The questions a staff member actually asks. Each SHOULD end in a card, because each
// implies a change to a record — not a lookup.
const PROMPTS = [
  "The client just sent through their bank statements. Note that on their account for me.",
  "Log on this account that we spoke today and they're waiting on the EIN.",
  "Put a note on this account that they've changed their business address.",
  "Record that we had a call with them this morning about the tax return.",
]

async function main() {
  process.env.WORKER_PANEL_APPROVALS = "true"

  const { data: acct } = await db
    .from("accounts")
    .select("id, company_name, notes")
    .eq("company_name", "Roma LLC")
    .maybeSingle()
  if (!acct?.id) {
    console.error("✋ No test account found.")
    process.exit(1)
  }
  const restoreNotes: string | null = acct.notes ?? null
  console.log(`Client on screen: ${acct.company_name}`)
  console.log(`Panel confirmations enabled: ${panelApprovalsEnabledFor("dashboard")}`)
  // The real panel injects a card telling the assistant WHO is on screen. Without it the
  // first run just asked "which client?" — a fault in this driver, not the feature.
  const clientCardSuffix = await buildClientCardSuffix(`account:${acct.id}`)
  // The real panel also allows the account's CONTACTS — without them the scope guard
  // refused a legitimate action on the very client that was on screen.
  const { data: contactRows } = await db.from("contacts").select("id").eq("account_id", acct.id)
  const relatedIds = (contactRows ?? []).map((c: { id: string }) => c.id)
  const scope = buildClientScope(`account:${acct.id}`, relatedIds)
  console.log(`Client card injected: ${clientCardSuffix.length > 0}\n`)

  let cardsSeen = 0
  for (const [i, prompt] of PROMPTS.entries()) {
    console.log(`${"─".repeat(70)}\n[${i + 1}] STAFF: ${prompt}\n`)
    const res = await callWorker(prompt, {
      // A fresh thread each time so one turn cannot coach the next.
      threadId: undefined,
      systemPromptOverride: buildWorkerSurfacePrompt("dashboard", {
        canSendEmail: false,
        canSendPortal: false,
        clientName: acct.company_name,
        canQueueApprovals: panelApprovalsEnabledFor("dashboard"),
      }) + clientCardSuffix,
      surface: "dashboard",
      panelSurface: "dashboard",
      enableDbRead: true,
      enableFullToolReach: true,
      maxIterations: 8,
      // Built the same way the real panel builds it — a hand-rolled shape crashed the guard.
      ...(scope ? { clientScope: scope } : {}),
      clientKey: `account:${acct.id}`,
      sendActor: "qa-behaviour-driver",
    })

    console.log(`ASSISTANT:\n${res.reply}\n`)
    const ids = (res.pendingActions ?? []).map((a) => a.id)
    const cards = await loadPendingActionCards(ids)
    if (cards.length) {
      cardsSeen++
      console.log(`✅ OFFERED ${cards.length} CARD(S):`)
      for (const c of cards) console.log(`   ▸ ${c.title} — ${JSON.stringify(c.params)}`)
    } else {
      console.log(`❌ NO CARD — it described the work instead of offering to do it.`)
    }
    console.log(`   tools it used: ${res.toolsUsed.join(", ") || "(none)"}`)
    for (const id of ids) await db.from("approval_queue").delete().eq("id", id)
  }

  await db.from("accounts").update({ notes: restoreNotes }).eq("id", acct.id)
  console.log(`\n${"═".repeat(70)}`)
  console.log(`VERDICT: offered a card on ${cardsSeen}/${PROMPTS.length} turns.`)
  console.log(
    cardsSeen === PROMPTS.length
      ? "✅ It reaches for the card on its own."
      : "❌ It does NOT reliably reach for the card — the feature would be inert in daily use.",
  )
  process.exit(cardsSeen === PROMPTS.length ? 0 : 1)
}

main().catch((e) => {
  console.error("💥", e)
  process.exit(1)
})
