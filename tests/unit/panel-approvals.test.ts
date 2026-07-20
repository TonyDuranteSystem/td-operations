/**
 * In-panel confirmation — the gate that decides whether an action may be offered as a
 * one-click card, and which actions may never be.
 *
 * WHY THESE TESTS EXIST. This job's whole history is false capability: the worker said it
 * could download a PDF that did not exist, said "say the word and I'll queue it" when the
 * queue was off, and offered a Slack bot that could not help. Each time, the fix that
 * held was deriving the claim from the real switch and proving the derivation with a
 * test. The switch below is what the capability sentence is generated from, so if it
 * drifts the worker starts promising confirmations the panel cannot draw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { panelApprovalsEnabledFor, mayBeConfirmedInPanel } from '@/lib/ai-agent/panel-approvals'
import { NO_APPROVAL_SEND_TOOLS } from '@/lib/ai-agent/tool-risk'
import { APPROVABLE_TOOL_CONSTRAINTS } from '@/lib/ai-agent/approvable-tools'

const ENV_KEYS = [
  'WORKER_PANEL_APPROVALS',
  'WORKER_PANEL_APPROVALS_DASHBOARD',
  'WORKER_PANEL_APPROVALS_INBOX',
  'WORKER_PANEL_APPROVALS_PORTAL_CHAT',
]

describe('panelApprovalsEnabledFor', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('is ON for every panel by default — the confirmation lives where the work is', () => {
    expect(panelApprovalsEnabledFor('dashboard')).toBe(true)
    expect(panelApprovalsEnabledFor('inbox')).toBe(true)
    expect(panelApprovalsEnabledFor('portal_chat')).toBe(true)
  })

  it('a per-surface switch kills one panel without touching the others', () => {
    process.env.WORKER_PANEL_APPROVALS_INBOX = 'false'
    expect(panelApprovalsEnabledFor('inbox')).toBe(false)
    expect(panelApprovalsEnabledFor('dashboard')).toBe(true)
    expect(panelApprovalsEnabledFor('portal_chat')).toBe(true)
  })

  it('the global switch turns everything off at once', () => {
    process.env.WORKER_PANEL_APPROVALS = 'false'
    expect(panelApprovalsEnabledFor('dashboard')).toBe(false)
    expect(panelApprovalsEnabledFor('inbox')).toBe(false)
    expect(panelApprovalsEnabledFor('portal_chat')).toBe(false)
  })

  it('a per-surface switch beats the global one in BOTH directions', () => {
    // Kill everything, keep one panel alive — the rollback shape if one surface misbehaves.
    process.env.WORKER_PANEL_APPROVALS = 'false'
    process.env.WORKER_PANEL_APPROVALS_DASHBOARD = 'true'
    expect(panelApprovalsEnabledFor('dashboard')).toBe(true)
    expect(panelApprovalsEnabledFor('inbox')).toBe(false)
  })

  it('a typo is treated as unset, never as ON', () => {
    // "TRUE"/"1"/"yes" are NOT accepted: a switch that guesses is a switch that turns
    // itself on when someone fat-fingers the value.
    process.env.WORKER_PANEL_APPROVALS = 'false'
    process.env.WORKER_PANEL_APPROVALS_INBOX = 'yes'
    expect(panelApprovalsEnabledFor('inbox')).toBe(false) // falls through to global, not ON
  })

  it('is case- and whitespace-tolerant on the values it does accept', () => {
    process.env.WORKER_PANEL_APPROVALS_INBOX = '  FALSE '
    expect(panelApprovalsEnabledFor('inbox')).toBe(false)
  })
})

describe('mayBeConfirmedInPanel', () => {
  it('refuses EVERY client-facing send tool', () => {
    // Not a sample — the whole set, so a send tool added later cannot quietly become
    // confirmable. A frozen payload cannot reproduce the live recipient re-derivation
    // that these tools' safety depends on.
    expect(NO_APPROVAL_SEND_TOOLS.size).toBeGreaterThan(0)
    for (const tool of NO_APPROVAL_SEND_TOOLS) {
      const gate = mayBeConfirmedInPanel(tool)
      expect(gate.ok, `${tool} must not be confirmable from a card`).toBe(false)
    }
  })

  it('explains the alternative rather than just refusing', () => {
    const [firstSendTool] = Array.from(NO_APPROVAL_SEND_TOOLS)
    const gate = mayBeConfirmedInPanel(firstSendTool)
    if (gate.ok !== false) throw new Error('expected a refusal')
    // A bare "not allowed" sends the staff member hunting. Name the working path.
    expect(gate.why).toContain(firstSendTool)
    expect(gate.why.toLowerCase()).toContain('chat')
  })

  it('refuses EVERY agent-side action flagged as leaving TD systems', () => {
    // REGRESSION GUARD — a live hole, found by the end-to-end run on 2026-07-20 and NOT by
    // any unit test. Two naming schemes reach this gate: catalog tools ("gmail_send", via
    // use_tool) and agent tools ("send_email", via propose_action). The refusal list holds
    // only catalog names, so `send_email` — a real client email — passed this gate AND the
    // executor's identical check, and would have been confirmable from a card with a
    // recipient frozen minutes earlier. Driven off the `external` flag so a newly-flagged
    // agent tool is covered without anyone remembering to update a second list.
    const external = Object.entries(APPROVABLE_TOOL_CONSTRAINTS).filter(([, c]) => c.external)
    expect(external.length).toBeGreaterThan(0)
    for (const [tool] of external) {
      expect(mayBeConfirmedInPanel(tool).ok, `${tool} leaves TD systems and must not be confirmable`).toBe(false)
    }
  })

  it('allows an ordinary record change — the case this feature exists for', () => {
    // Antonio's example: move Banking to Documents Received, add a note, set a follow-up.
    // Both naming schemes, since both are real callers.
    expect(mayBeConfirmedInPanel('create_task').ok).toBe(true)
    expect(mayBeConfirmedInPanel('advance_service_stage').ok).toBe(true)
    expect(mayBeConfirmedInPanel('crm_update_record').ok).toBe(true)
  })

  it('keeps the INTERNAL team note confirmable — it is not a client send', () => {
    // The distinction that matters: staff-only notes stay one-click, client-facing sends
    // do not. Over-blocking here would quietly gut the feature.
    expect(mayBeConfirmedInPanel('send_team_message').ok).toBe(true)
  })
})
