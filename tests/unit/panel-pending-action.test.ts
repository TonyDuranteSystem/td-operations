/**
 * The propose→card handoff: the two doors that stop an action being offered for a click,
 * and the marker the server reads to build the card.
 *
 * WHY THE MARKER IS SERVER-READ. The panel does not build a card from anything the model
 * wrote. It reads an id out of OUR OWN tool output, then loads the frozen row from the
 * queue. The same lesson as the PDF: the first live run produced the file and then dropped
 * the link from its own answer. What the model says and what actually happened are
 * separate channels, and the UI has to be driven by the one the model cannot author.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { extractPendingAction, proposeAction } from '@/lib/ai-agent/worker-tools'

describe('extractPendingAction', () => {
  it('reads the id out of our own tool output', () => {
    const out = [
      '✅ Ready for your confirmation — NOTHING has run yet.',
      'PendingAction: 11111111-2222-4333-8444-555555555555',
      '',
      'Tell them briefly what it will do and stop.',
    ].join('\n')
    expect(extractPendingAction('use_tool', out)).toEqual({ id: '11111111-2222-4333-8444-555555555555' })
  })

  it('ignores the marker from any other tool', () => {
    // The pattern must not be forgeable through some unrelated tool that happens to
    // echo text back — only the propose path mints cards.
    const out = 'PendingAction: 11111111-2222-4333-8444-555555555555'
    expect(extractPendingAction('crm_query', out)).toBeNull()
    expect(extractPendingAction('run_sql_query', out)).toBeNull()
  })

  it('does not match a marker the model merely mentioned mid-sentence', () => {
    // Must be its own line. "I'll write PendingAction: <id> for you" is prose, not a fact.
    const prose = 'I will queue it and write PendingAction: 11111111-2222-4333-8444-555555555555 now'
    expect(extractPendingAction('use_tool', prose)).toBeNull()
  })

  it('returns null when nothing was frozen', () => {
    expect(extractPendingAction('use_tool', 'Found 3 accounts.')).toBeNull()
    expect(extractPendingAction('use_tool', undefined)).toBeNull()
    expect(extractPendingAction('use_tool', { id: 'x' })).toBeNull()
  })
})

describe('proposeAction — the two doors, checked before anything is written', () => {
  const KEYS = ['WORKER_PANEL_APPROVALS', 'WORKER_PANEL_APPROVALS_INBOX', 'WORKER_ACTIONS_ENABLED']
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('refuses a client-facing send BEFORE queueing it', async () => {
    // The outer of two doors. The executor refuses these as well, but a proposal that can
    // never exist is stronger than one refused on the way out: it also means the staff
    // member is never shown a card for something that would fail at the click.
    const out = await proposeAction(
      { tool_name: 'gmail_send', params: { to: 'someone@example.com', subject: 'x', body: 'y' } },
      { panelSurface: 'inbox' },
    )
    expect(out).toContain('❌')
    expect(out).toContain('gmail_send')
    // And it must point at the path that works, not just say no.
    expect(out.toLowerCase()).toContain('chat')
  })

  it('queues nothing when the panel switch is off', async () => {
    process.env.WORKER_PANEL_APPROVALS = 'false'
    const out = await proposeAction(
      { tool_name: 'crm_create_task', params: { title: 'Follow up Thursday' } },
      { panelSurface: 'inbox' },
    )
    // The off-message, not a card and not a claim that it was queued.
    expect(out).not.toContain('PendingAction:')
  })

  it('does not fall back to the abandoned rail when the panel switch is off', async () => {
    // Both switches independent: turning the panel off must not silently route the
    // action into the old Telegram-code rail, and vice versa.
    process.env.WORKER_PANEL_APPROVALS = 'false'
    process.env.WORKER_ACTIONS_ENABLED = 'true'
    const out = await proposeAction(
      { tool_name: 'crm_create_task', params: { title: 'Follow up Thursday' } },
      { panelSurface: 'inbox' },
    )
    expect(out).not.toContain('PendingAction:')
    expect(out).not.toContain('confirmation_code')
  })
})
