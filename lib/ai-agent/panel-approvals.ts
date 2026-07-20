/**
 * In-panel confirmation for actions that change something.
 *
 * Antonio, 2026-07-20: "let it actually carry out actions rather than handing them back
 * to you." Today the assistant can look anything up but every action comes back as a
 * description — "you'll want to move Banking to the next stage, add a note, set a
 * follow-up" — and the staff member does the three things by hand.
 *
 * WHAT THIS IS NOT. There was an earlier approval rail: propose → queue → a 6-digit
 * code typed back over Telegram. Antonio abandoned it (2026-07-10, R108) and it stays
 * abandoned — in five weeks it ran three trivial actions, because the confirmation had
 * to happen somewhere other than where the work was. That switch (WORKER_ACTIONS_ENABLED)
 * remains OFF and governs that old path; this is a different transport on the same
 * proven table and executor, with its own switch so either can be killed alone.
 *
 * WHAT MAKES THIS DIFFERENT: the confirmation happens in the same panel, in the same
 * conversation, one click, showing the real frozen payload. Nothing to re-type, nothing
 * to go and find.
 *
 * WHAT IS REUSED, AND WHY. The freeze, the params hash, the atomic single-winner claim
 * and the integrity re-check at execute time were all reviewed by the council on
 * 2026-07-18 and found sound. Rebuilding them would mean re-earning that review. Only
 * the two parts the council called wrong are replaced: the transport (Telegram code →
 * panel button) and the render (a formatter that only understood 14 tools and showed a
 * bare tool name for everything else).
 *
 * WHAT CANNOT COME THROUGH HERE: client-facing sends. Their recipient pin lives on the
 * worker's own send path, and an approved send would execute with whatever recipient was
 * frozen rather than re-deriving it live — the exact hole the council closed. Sends keep
 * their existing path, where the worker shows the draft and sends on the staff member's
 * "go". The executor refuses them too; this is the outer of the two doors.
 */

import { NO_APPROVAL_SEND_TOOLS } from '@/lib/ai-agent/tool-risk'
import { APPROVABLE_TOOL_CONSTRAINTS } from '@/lib/ai-agent/approvable-tools'

/**
 * Per-surface switch. ON by default for the CRM panels — the whole point is that the
 * confirmation lives where the work is. Set to "false" to kill it on one surface without
 * touching the others, or without disturbing the old (still-off) rail.
 */
const ENV_BY_SURFACE: Record<PanelSurface, string> = {
  dashboard: 'WORKER_PANEL_APPROVALS_DASHBOARD',
  inbox: 'WORKER_PANEL_APPROVALS_INBOX',
  portal_chat: 'WORKER_PANEL_APPROVALS_PORTAL_CHAT',
}

export type PanelSurface = 'dashboard' | 'inbox' | 'portal_chat'

function readBool(raw: string | undefined): boolean | null {
  if (raw === undefined) return null
  const v = raw.trim().toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  return null // unrecognised → treat as unset, never guess
}

/** Whether this surface may offer an in-panel confirmation on this turn. */
export function panelApprovalsEnabledFor(surface: PanelSurface): boolean {
  const perSurface = readBool(process.env[ENV_BY_SURFACE[surface]])
  if (perSurface !== null) return perSurface
  const global = readBool(process.env.WORKER_PANEL_APPROVALS)
  if (global !== null) return global
  return true
}

/**
 * Actions that may NEVER be offered as an in-panel confirmation.
 *
 * Client-facing sends: see the header. Their safety is the live recipient re-derivation
 * on the worker's own send path, which a frozen payload cannot reproduce.
 *
 * Checked HERE at propose time as well as in the executor. Two doors on purpose: the
 * council's finding was that the send guard lived only in the executor, so a future
 * change that swapped the executor would silently drop it. A proposal that can never be
 * created is a stronger guarantee than one that is refused on the way out.
 */
export function mayBeConfirmedInPanel(toolName: string): { ok: true } | { ok: false; why: string } {
  // TWO NAMING SCHEMES REACH THIS GATE, and missing one was a live hole found by the
  // end-to-end run on 2026-07-20. Actions arrive either as catalog tools (`gmail_send`,
  // via use_tool) or as agent tools (`send_email`, via propose_action). NO_APPROVAL_SEND_TOOLS
  // lists ONLY catalog names, so `send_email` — a real client email — sailed through this
  // gate AND the executor's identical check. Whichever scheme a caller uses, an action
  // that leaves the building must be refused, so the agent side is judged by its own
  // authoritative `external` flag rather than by a second hardcoded list that would drift
  // out of step the same way.
  if (APPROVABLE_TOOL_CONSTRAINTS[toolName]?.external) {
    return {
      ok: false,
      why:
        `"${toolName}" leaves TD's systems and cannot be confirmed from a card — a send has to be ` +
        `aimed at its recipient at the moment it goes, not at the moment it was written. Draft it in ` +
        `the chat instead and send it on your go; that path checks the recipient live.`,
    }
  }
  if (NO_APPROVAL_SEND_TOOLS.has(toolName)) {
    return {
      ok: false,
      why:
        `"${toolName}" cannot be confirmed from a card — a send has to be aimed at its recipient ` +
        `at the moment it goes, not at the moment it was written. Draft it in the chat instead and ` +
        `send it on your go; that path checks the recipient live.`,
    }
  }
  return { ok: true }
}

/** What the panel needs to render a confirmation card. */
export interface PendingActionCard {
  id: string
  /** The tool that will run, exactly as stored. */
  tool: string
  /** The frozen values, exactly as stored — this is what the staff member approves. */
  params: Record<string, unknown>
  /** One line for the card header, derived from the tool name. */
  title: string
}

/**
 * Load the frozen rows for a set of ids, straight from the queue.
 *
 * The card is built from the STORED ROW, never from anything the model wrote. That is
 * the whole point: the council's finding on the previous rail was that an approval
 * rendering the assistant's own description lets a person approve one thing and get
 * another. Rows that are no longer pending are dropped — a card for something already
 * confirmed or discarded would invite a second click that does nothing.
 */
export async function loadPendingActionCards(ids: string[]): Promise<PendingActionCard[]> {
  if (!ids.length) return []
  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from('approval_queue')
    .select('id, tool_name, params, status')
    .in('id', ids)
    .eq('status', 'pending')

  return ((data ?? []) as Array<{ id: string; tool_name: string; params: Record<string, unknown> }>).map((r) => ({
    id: r.id,
    tool: r.tool_name,
    params: r.params ?? {},
    title: humanTitle(r.tool_name),
  }))
}

export type ConfirmOutcome =
  | { ok: true; status: 'executed' | 'discarded' }
  | { ok: false; code: 'gone' | 'failed'; error: string }

/**
 * Decide a frozen action: run it, or drop it.
 *
 * THIS IS THE WHOLE DECISION, deliberately separated from the HTTP route so it can be
 * exercised against a real database — including the double-click race, which is the one
 * behaviour that cannot be proven by reasoning about the code. The route above it does
 * auth, parses the body, and calls this; everything that decides what happens is here.
 *
 * The atomic compare-and-set IS the concurrency guard. Two clicks (or a click racing a
 * discard) both attempt pending → approved; exactly one matches a row. The loser is told
 * plainly rather than silently doing nothing, and — critically — never reaches the
 * executor. A read-then-write here would let a double-click run the action twice, which
 * on an invoice tool means two invoices.
 */
export async function confirmPendingAction(
  id: string,
  actor: string,
  choice: 'confirm' | 'discard' = 'confirm',
): Promise<ConfirmOutcome> {
  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const nowIso = new Date().toISOString()
  // decided_by is CHECK char_length <= 100 — a long address would fail the whole update
  // and lose the decision rather than just the label.
  const who = actor.slice(0, 100)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  const nextStatus = choice === 'discard' ? 'rejected' : 'approved'
  const { data: claimed } = await db
    .from('approval_queue')
    .update({ status: nextStatus, decided_by: who, decided_at: nowIso, updated_at: nowIso })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id, tool_name, params')
    .maybeSingle()

  if (!claimed) {
    return {
      ok: false,
      code: 'gone',
      error: 'That action is no longer waiting — it was already confirmed or discarded.',
    }
  }
  if (choice === 'discard') return { ok: true, status: 'discarded' }

  // Reuses the reviewed executor: its own atomic approved → executing claim, the
  // params-hash integrity re-check, and the refusal of client-facing sends.
  const { executeApproval } = await import('@/lib/ai-agent/approval-executor')
  const result = await executeApproval(id)

  // AUDIT — this path recorded nothing before, so there was no answer to "who told it to
  // do that". Fire-and-forget by design: a logging failure must never change whether the
  // action ran, nor report failure for something that already happened.
  const { logAction } = await import('@/lib/mcp/action-log')
  logAction({
    actor: `crm-panel:${who}`,
    action_type: 'update',
    table_name: 'approval_queue',
    record_id: id,
    summary: `Confirmed in panel: ${claimed.tool_name} → ${result.status}`,
    details: { tool: claimed.tool_name, params: claimed.params, outcome: result.status },
  })

  if (result.status === 'executed') return { ok: true, status: 'executed' }
  // Ran but did not succeed — say why, so the staff member knows whether to retry or do
  // it by hand rather than being told a bare "failed".
  return {
    ok: false,
    code: 'failed',
    error: `The action did not complete (${result.reason ?? result.status}).`,
  }
}

/**
 * A readable name for a tool, for the card header.
 *
 * Falls back to the raw tool name rather than inventing a description — a wrong label on
 * a confirmation is worse than an ugly one, because the label is what gets approved.
 */
function humanTitle(tool: string): string {
  // Agent tools already carry a curated label — use it rather than keeping a second list
  // that says something slightly different about the same action.
  const constraint = APPROVABLE_TOOL_CONSTRAINTS[tool]
  if (constraint?.label) return constraint.label
  // Catalog tools (reached via use_tool) have no such metadata, so these are ours.
  const KNOWN: Record<string, string> = {
    crm_create_task: 'Create a task',
    crm_update_record: 'Update a record',
    crm_create_contact: 'Create a contact',
    crm_create_account: 'Create an account',
    sd_advance_stage: 'Advance a service to the next stage',
    sd_create: 'Create a service',
    service_deactivate: 'Deactivate a service',
    service_reactivate: 'Reactivate a service',
    deadline_update: 'Update a deadline',
    conv_log: 'Log a conversation',
    drive_upload_file: 'Upload a file to Drive',
    drive_create_folder: 'Create a Drive folder',
    kb_create: 'Add a knowledge article',
    kb_update: 'Update a knowledge article',
    portal_invoice_create: 'Create an invoice',
    lead_update: 'Update a lead',
    lead_create: 'Create a lead',
    tax_update: 'Update a tax return',
  }
  return KNOWN[tool] ?? tool
}
