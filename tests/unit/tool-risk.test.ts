/**
 * Risk classification contract (dev job 74701b48).
 *
 * REWRITTEN 2026-07-19. The previous version of this file asserted the behaviour that
 * caused the incident: that `gmail_read`, `cb_get_call` and `crm_search_accounts` were
 * READ and therefore auto-runnable, purely because their names contained "read"/"get"/
 * "search". Run against the real catalog that heuristic auto-approved 106 of 216 tools,
 * among them one that emails every client's EIN to a model-chosen address and one that
 * overwrites a client's filed P&L.
 *
 * Those old assertions were not wrong about the code — the code did that. They were
 * wrong about what the code SHOULD do, and passing tests made the danger look reviewed.
 * They are replaced here rather than deleted, so the reversal is on the record.
 *
 * The contract now: a tool auto-runs ONLY by being on the reviewed allow-list.
 * Catalog-wide coverage lives in tool-risk-catalog.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { classifyTool, decideAction, HARD_BLOCKED_TOOLS, EXTERNAL_TOOLS, READ_TOOLS } from '@/lib/ai-agent/tool-risk'

describe('classifyTool', () => {
  it('curated external tools are EXTERNAL', () => {
    expect(classifyTool('gmail_send').tier).toBe('EXTERNAL')
    expect(classifyTool('referral_payout').tier).toBe('EXTERNAL')
    expect(classifyTool('drive_delete').tier).toBe('EXTERNAL')
    expect(classifyTool('sd_advance_stage').tier).toBe('EXTERNAL')
  })

  it('allow-listed tools are READ', () => {
    expect(classifyTool('crm_search_services').tier).toBe('READ')
    expect(classifyTool('calendar_list_events').tier).toBe('READ')
    expect(classifyTool('deadline_upcoming').tier).toBe('READ')
    expect(classifyTool('catalog_list').tier).toBe('READ')
  })

  it('REVERSAL: a read-sounding name is no longer enough to auto-run', () => {
    // Every one of these was asserted READ by the previous version of this file.
    // gmail_read reads ANY mailbox via as_user; cb_get_call returns the transcript and
    // a recording URL; crm_search_accounts returns EIN in bulk.
    expect(classifyTool('gmail_read').tier).toBe('EXTERNAL')
    expect(classifyTool('cb_get_call').tier).toBe('EXTERNAL')
    expect(classifyTool('crm_search_accounts').tier).toBe('EXTERNAL')
  })

  it('parameter escalation overrides the allow-list', () => {
    expect(classifyTool('doc_search').tier).toBe('READ')
    expect(classifyTool('doc_search', { apply_changes: true }).tier).toBe('EXTERNAL')
    expect(classifyTool('doc_search', { send_email: true }).tier).toBe('EXTERNAL')
  })

  it('a flag explicitly switched off does not escalate', () => {
    expect(classifyTool('doc_search', { apply_changes: false }).tier).toBe('READ')
  })

  it('fail-safe: an unknown tool requires approval and says why', () => {
    expect(classifyTool('frobnicate_widget').tier).toBe('EXTERNAL')
    expect(classifyTool('frobnicate_widget').reasons.join()).toMatch(/not on the reviewed allow-list/)
  })
})

describe('decideAction', () => {
  it('allow-listed → auto; everything else → approval', () => {
    expect(decideAction('crm_search_services').decision).toBe('auto')
    expect(decideAction('crm_update_record').decision).toBe('approval')
    expect(decideAction('gmail_send').decision).toBe('approval')
  })

  it('hard-blocked tools are blocked', () => {
    expect(decideAction('execute_sql').decision).toBe('blocked')
    for (const t of Array.from(HARD_BLOCKED_TOOLS)) expect(decideAction(t).decision, t).toBe('blocked')
  })

  it('SAFETY INVARIANT: no curated external tool is ever auto, under any config', () => {
    for (const t of Array.from(EXTERNAL_TOOLS)) {
      expect(decideAction(t).decision, t).not.toBe('auto')
      expect(decideAction(t, {}, { writeInternalAuto: true }).decision, t).not.toBe('auto')
    }
  })

  it('SAFETY INVARIANT: the two sets never overlap', () => {
    const both = Array.from(READ_TOOLS).filter((t) => EXTERNAL_TOOLS.has(t) || HARD_BLOCKED_TOOLS.has(t))
    expect(both, `allow-listed AND restricted: ${both.join(', ')}`).toEqual([])
  })

  it('writeInternalAuto cannot promote anything today — nothing is WRITE_INTERNAL any more', () => {
    // The tier and its config survive as the hook for a future reviewed list of
    // low-stakes internal writes (leaving a note, moving a board card) that should run
    // without asking, so routine bookkeeping does not train people to tap yes.
    // Until that list exists, no tool reaches this tier, and the config is inert.
    expect(decideAction('crm_update_record', {}, { writeInternalAuto: true }).decision).toBe('approval')
  })

  it('look-like-reads-but-write tools stay gated', () => {
    for (const t of ['doc_map_folders', 'hc_download_delivery', 'catalog_pending']) {
      expect(decideAction(t).decision, t).not.toBe('auto')
    }
  })
})
