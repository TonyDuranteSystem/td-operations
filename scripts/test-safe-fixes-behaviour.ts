/* eslint-disable no-console -- dev-only QA driver, never shipped to runtime */
/**
 * Live behaviour check for the three safe fixes, driving the REAL assistant.
 *
 * Measures two things that only appear at runtime:
 *  · does it now FIND its tools when asked in normal English (the search fix), and
 *  · does it know the client's address (the contact-lookup fix)?
 * And one thing that must NOT have changed: no confirmation-card behaviour, since that
 * work was deliberately left out of this branch.
 */
import { config } from "dotenv"
config({ path: ".env.local" })
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
if (!url.includes("127.0.0.1") && !url.includes("localhost")) { console.error("✋ local only"); process.exit(1) }
if (!process.env.ANTHROPIC_API_KEY) { console.error("✋ needs a model key for this run"); process.exit(1) }

import { callWorker } from "@/lib/ai-agent/worker-tools"
import { buildWorkerSurfacePrompt } from "@/lib/ai-agent/inbox-worker-prompt"
import { buildSidebarSendRails } from "@/lib/ai-agent/sidebar-send-rails"
import { buildClientCardSuffix } from "@/lib/ai-agent/client-card"
import { workerActionsEnabled } from "@/lib/ai-agent/worker-actions-switch"
import { supabaseAdmin } from "@/lib/supabase-admin"
const db = supabaseAdmin as any

const PROMPTS = [
  "Who is this client and what's open with them?",
  "Draft a short email to them asking for their bank statements.",
  "Make me a one-page PDF letter to the IRS about their name change. Old name was Creatives Group LLC, new name Oh My Creatives LLC, signed by Damiano Mocellin, address 1209 Mountain Road Pl NE, Albuquerque NM 87110. Just produce it.",
]

async function main() {
  const { data: link } = await db.from("account_contacts").select("account_id").limit(1).maybeSingle()
  const accountId = link.account_id
  const clientKey = `account:${accountId}`
  const rails = await buildSidebarSendRails(clientKey)
  const clientCardSuffix = await buildClientCardSuffix(clientKey)
  console.log(`Client: ${rails.clientName}`)
  console.log(`Addresses the assistant can reach: ${rails.email.pinnedEmailRecipients?.length ?? 0}\n`)

  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i]
    console.log(`${"─".repeat(70)}\n[${i + 1}] STAFF: ${prompt}\n`)
    const res = await callWorker(prompt, {
      systemPromptOverride: buildWorkerSurfacePrompt("dashboard", {
        canSendEmail: rails.email.enableEmailSend === true && (rails.email.pinnedEmailRecipients?.length ?? 0) > 0,
        canSendPortal: (rails.portal as any)?.enableSlackSend === true,
        clientName: rails.clientName,
        canQueueApprovals: workerActionsEnabled(),
      }) + clientCardSuffix,
      surface: "dashboard",
      enableDbRead: true, enableDocReads: true, enableFullToolReach: true, maxIterations: 20,
      ...(rails.portal as object), ...(rails.email as object),
      ...(rails.clientScope ? { clientScope: rails.clientScope } : {}),
      clientKey, sendActor: "qa-safe-fixes",
    })
    console.log(`ASSISTANT:\n${res.reply.slice(0, 900)}\n`)
    console.log(`   tools used: ${res.toolsUsed.join(", ") || "(none)"}`)
    console.log(`   files produced: ${(res.artifacts ?? []).length}`)
    const badCardClaim = /confirm with (one click|a click|the card)|click confirm|the card (above|below)/i.test(res.reply)
    console.log(`   ${badCardClaim ? "❌ claims a card exists (must NOT — no cards on this branch)" : "✓ no phantom card claim"}`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error("💥", e); process.exit(1) })
