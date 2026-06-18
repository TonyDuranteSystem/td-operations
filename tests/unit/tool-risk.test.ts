import { describe, it, expect } from 'vitest'
import { classifyTool, decideAction, HARD_BLOCKED_TOOLS, EXTERNAL_TOOLS } from '@/lib/ai-agent/tool-risk'

describe('classifyTool', () => {
  it('curated external tools are EXTERNAL regardless of naming', () => {
    expect(classifyTool('gmail_send').tier).toBe('EXTERNAL')
    expect(classifyTool('referral_payout').tier).toBe('EXTERNAL')
    expect(classifyTool('drive_delete').tier).toBe('EXTERNAL')
    expect(classifyTool('sd_advance_stage').tier).toBe('EXTERNAL')
  })

  it('segment-based naming recognizes domain-prefixed reads as READ', () => {
    expect(classifyTool('crm_search_accounts').tier).toBe('READ')
    expect(classifyTool('gmail_read').tier).toBe('READ')
    expect(classifyTool('cb_get_call').tier).toBe('READ')
    expect(classifyTool('calendar_list_events').tier).toBe('READ')
    expect(classifyTool('deadline_upcoming').tier).toBe('READ')
  })

  it('does NOT mistake "catalog" for the "log" write-verb (segment match, not substring)', () => {
    // catalog_list → segments [catalog, list] → "list" is a read verb, no "log" match.
    expect(classifyTool('catalog_list').tier).toBe('READ')
  })

  it('internal mutations are WRITE_INTERNAL', () => {
    expect(classifyTool('crm_update_record').tier).toBe('WRITE_INTERNAL')
    expect(classifyTool('crm_create_task').tier).toBe('WRITE_INTERNAL')
    expect(classifyTool('deadline_update').tier).toBe('WRITE_INTERNAL')
  })

  it('parameter-aware escalation: a review/prepare tool escalates to EXTERNAL when it applies/sends', () => {
    expect(classifyTool('formation_form_review').tier).toBe('READ')
    expect(classifyTool('formation_form_review', { apply_changes: true }).tier).toBe('EXTERNAL')
    expect(classifyTool('itin_prepare_documents', { send_email: true }).tier).toBe('EXTERNAL')
    // falsey flag does not escalate
    expect(classifyTool('formation_form_review', { apply_changes: false }).tier).toBe('READ')
  })

  it('fail-safe: an unknown/unclassifiable tool defaults to EXTERNAL', () => {
    expect(classifyTool('frobnicate_widget').tier).toBe('EXTERNAL')
    expect(classifyTool('frobnicate_widget').reasons.join()).toMatch(/FAIL-SAFE/)
  })
})

describe('decideAction', () => {
  it('READ → auto, WRITE_INTERNAL → approval (ask me) by default, EXTERNAL → approval', () => {
    expect(decideAction('crm_search_accounts').decision).toBe('auto')
    expect(decideAction('crm_update_record').decision).toBe('approval')
    expect(decideAction('gmail_send').decision).toBe('approval')
  })

  it('hard-blocked tools are blocked', () => {
    expect(decideAction('execute_sql').decision).toBe('blocked')
    for (const t of HARD_BLOCKED_TOOLS) expect(decideAction(t).decision).toBe('blocked')
  })

  it('writeInternalAuto config can opt internal writes into auto (NOT the chosen default)', () => {
    expect(decideAction('crm_update_record', {}, { writeInternalAuto: true }).decision).toBe('auto')
    // external still requires approval even with the config on
    expect(decideAction('gmail_send', {}, { writeInternalAuto: true }).decision).toBe('approval')
  })

  it('SAFETY INVARIANT: no curated external tool is ever auto', () => {
    for (const t of EXTERNAL_TOOLS) {
      expect(decideAction(t).decision).not.toBe('auto')
      expect(decideAction(t, {}, { writeInternalAuto: true }).decision).not.toBe('auto')
    }
  })

  it('curation: verified read-only tools are auto', () => {
    for (const t of ['classify_document', 'classify_text', 'doc_compliance_check', 'gmail_labels']) {
      expect(decideAction(t).decision).toBe('auto')
    }
  })

  it('curation: look-like-reads-but-write tools stay gated (NOT auto)', () => {
    // doc_map_folders writes via updateDocument; hc_download_delivery uploads to Drive;
    // catalog_pending writes when action=resolve. All must NOT auto-run.
    for (const t of ['doc_map_folders', 'hc_download_delivery', 'catalog_pending']) {
      expect(decideAction(t).decision).not.toBe('auto')
    }
  })
})
