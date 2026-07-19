/**
 * The legacy dashboard-sidebar engine must not act without permission (dev job 17459c25).
 *
 * Context: the sidebar is mounted on every dashboard page. When the worker path is off
 * (its default) the sidebar runs this legacy engine, which dispatches whatever the model
 * emits straight to executeTool — no permission step, no recipient pin, no classifier.
 * `send_email` on this path reaches a real client with nobody approving it.
 *
 * These tests pin the containment: the dangerous names are absent from the tool list the
 * model is shown, and the set stays aligned with what the executor can actually dispatch,
 * so a newly-added mutating tool cannot quietly become reachable here.
 */

import { describe, it, expect } from 'vitest'
import { LEGACY_AGENT_BLOCKED_TOOLS } from '@/lib/ai-agent/providers'
import { AGENT_TOOLS } from '@/lib/ai-agent/tools'

describe('legacy sidebar engine — blocked tool set', () => {
  it('blocks every tool that sends to a client or leaves the building', () => {
    for (const name of ['send_email', 'send_team_message']) {
      expect(LEGACY_AGENT_BLOCKED_TOOLS.has(name), name).toBe(true)
    }
  })

  it('blocks every tool that changes client or system state', () => {
    for (const name of [
      'create_task',
      'update_task',
      'update_account_notes',
      'update_contact',
      'update_service',
      'update_deadline',
      'advance_service_stage',
      'drive_move',
      'drive_upload_file',
    ]) {
      expect(LEGACY_AGENT_BLOCKED_TOOLS.has(name), name).toBe(true)
    }
  })

  it('keeps lookups available — this is a safety fix, not a lobotomy', () => {
    for (const name of [
      'search_accounts',
      'get_account_detail',
      'get_client_360',
      'gmail_search',
      'gmail_read',
      'run_sql_query',
      'search_kb',
      'portal_chat_read',
      'recall_memories',
    ]) {
      expect(LEGACY_AGENT_BLOCKED_TOOLS.has(name), name).toBe(false)
    }
  })

  it('every blocked name is a real tool — a typo here silently protects nothing', () => {
    const real = new Set(AGENT_TOOLS.map(t => t.name))
    for (const name of Array.from(LEGACY_AGENT_BLOCKED_TOOLS)) {
      expect(real.has(name), `${name} is not a registered agent tool`).toBe(true)
    }
  })

  it('REGRESSION GATE: no unblocked agent tool has a mutating/sending name', () => {
    // Catches a NEW write tool added to AGENT_TOOLS without deciding about this path.
    // If this fails, either add the tool to LEGACY_AGENT_BLOCKED_TOOLS or, if it is
    // genuinely read-only despite its name, add it to the exceptions below with a reason.
    const readOnlyDespiteName = new Set([
      'save_memory', // the assistant's own notes, not client or system state
      'memory_save', // same
      'log_conversation', // records what was discussed; no client-visible effect
      'update_deadline', // already blocked; listed for clarity if it is ever unblocked
    ])
    const suspicious = AGENT_TOOLS.map(t => t.name)
      .filter(n => /^(create|update|send|advance|delete|upload|move|mark|set|add)_/.test(n))
      .filter(n => !LEGACY_AGENT_BLOCKED_TOOLS.has(n))
      .filter(n => !readOnlyDespiteName.has(n))
    expect(suspicious, `unclassified mutating tools reachable from the sidebar: ${suspicious.join(', ')}`).toEqual([])
  })
})
