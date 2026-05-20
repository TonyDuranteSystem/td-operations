import { describe, it, expect, vi } from 'vitest'

// Mock supabaseAdmin so importing the module never touches a real client.
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import { buildDispatchLogRow } from '@/lib/tasks/workflow-dispatch-log'
import type { DispatchResult } from '@/lib/tasks/dispatch-workflow-for-event'

describe('buildDispatchLogRow', () => {
  it('maps a successful spawn to outcome=spawned with the task id', () => {
    const result: DispatchResult = { spawned: true, workflow_slug: 'itin_review', task_id: 'task-1' }
    const row = buildDispatchLogRow({
      trigger_source: 'form_submission',
      event_descriptor: 'itin_submissions',
      event_ref: 'sub-1',
      result,
      account_id: 'acc-1',
      contact_id: 'con-1',
      actor: 'system',
      extra_details: { form_table: 'itin_submissions' },
    })
    expect(row.outcome).toBe('spawned')
    expect(row.matched_workflow_slug).toBe('itin_review')
    expect(row.spawned_task_id).toBe('task-1')
    expect(row.trigger_source).toBe('form_submission')
    expect(row.event_descriptor).toBe('itin_submissions')
    expect(row.event_ref).toBe('sub-1')
    expect(row.account_id).toBe('acc-1')
    expect(row.contact_id).toBe('con-1')
    expect(row.details).toEqual({ form_table: 'itin_submissions' })
    expect(row.candidates).toBeNull()
  })

  it('maps no_trigger_match (no reason defaults safely)', () => {
    const result: DispatchResult = { spawned: false, reason: 'no_trigger_match' }
    const row = buildDispatchLogRow({ trigger_source: 'sd_created', result })
    expect(row.outcome).toBe('no_trigger_match')
    expect(row.matched_workflow_slug).toBeNull()
    expect(row.spawned_task_id).toBeNull()
  })

  it('defaults to no_trigger_match when not spawned and reason is absent', () => {
    const result = { spawned: false } as DispatchResult
    const row = buildDispatchLogRow({ trigger_source: 'sd_created', result })
    expect(row.outcome).toBe('no_trigger_match')
  })

  it('maps ambiguous with the competing candidates', () => {
    const result: DispatchResult = {
      spawned: false,
      reason: 'ambiguous',
      candidates: ['banking_review_payset', 'banking_review_relay'],
    }
    const row = buildDispatchLogRow({
      trigger_source: 'form_submission',
      event_descriptor: 'banking_submissions',
      result,
    })
    expect(row.outcome).toBe('ambiguous')
    expect(row.candidates).toEqual(['banking_review_payset', 'banking_review_relay'])
  })

  it('captures meta_error into details on meta_invalid', () => {
    const result: DispatchResult = {
      spawned: false,
      reason: 'meta_invalid',
      workflow_slug: 'tax_form_review',
      meta_error: 'expected string, got number',
    }
    const row = buildDispatchLogRow({ trigger_source: 'form_submission', result })
    expect(row.outcome).toBe('meta_invalid')
    expect(row.matched_workflow_slug).toBe('tax_form_review')
    expect(row.details.meta_error).toBe('expected string, got number')
  })

  it('captures spawn_error into details on spawn_failed', () => {
    const result: DispatchResult = {
      spawned: false,
      reason: 'spawn_failed',
      workflow_slug: 'closure_progress',
      spawn_error: 'insert failed',
    }
    const row = buildDispatchLogRow({ trigger_source: 'sd_created', result })
    expect(row.outcome).toBe('spawn_failed')
    expect(row.details.spawn_error).toBe('insert failed')
  })

  it('maps already_spawned with the existing task id (benign webhook retry)', () => {
    const result: DispatchResult = {
      spawned: false,
      reason: 'already_spawned',
      task_id: 'existing-task',
      workflow_slug: 'itin_review',
    }
    const row = buildDispatchLogRow({ trigger_source: 'form_submission', result })
    expect(row.outcome).toBe('already_spawned')
    expect(row.spawned_task_id).toBe('existing-task')
  })

  it('null-coalesces every optional context field and never carries chained_from in Step 1', () => {
    const result: DispatchResult = { spawned: false, reason: 'no_trigger_match' }
    const row = buildDispatchLogRow({ trigger_source: 'sd_created', result })
    expect(row.event_descriptor).toBeNull()
    expect(row.event_ref).toBeNull()
    expect(row.account_id).toBeNull()
    expect(row.contact_id).toBeNull()
    expect(row.delivery_id).toBeNull()
    expect(row.actor).toBeNull()
    expect(row.chained_from_id).toBeNull()
    expect(row.details).toEqual({})
  })
})
