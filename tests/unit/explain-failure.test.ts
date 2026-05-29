import { describe, it, expect } from 'vitest'
import {
  explainFailure,
  extractConstraintName,
  extractColumnName,
} from '@/lib/errors/explain-failure'

describe('extractConstraintName', () => {
  it('pulls the constraint name out of a Postgres message', () => {
    expect(extractConstraintName('duplicate key value violates unique constraint "uq_members_account_contact"'))
      .toBe('uq_members_account_contact')
  })
  it('returns null when none present', () => {
    expect(extractConstraintName('some other error')).toBeNull()
  })
})

describe('extractColumnName', () => {
  it('pulls and humanizes a column name', () => {
    expect(extractColumnName('null value in column "tenant_title" violates not-null constraint'))
      .toBe('tenant title')
  })
})

describe('explainFailure', () => {
  it('uses the friendly override for a known constraint', () => {
    const r = explainFailure({
      code: '23505',
      message: 'duplicate key value violates unique constraint "uq_members_account_contact"',
    })
    expect(r.message).toMatch(/already a member/i)
    expect(r.technical).toMatch(/uq_members_account_contact/)
  })

  it('generic duplicate message for an unknown unique constraint', () => {
    const r = explainFailure({ code: '23505', message: 'duplicate key value violates unique constraint "uq_widgets"' })
    expect(r.message).toMatch(/duplicate/i)
  })

  it('names the missing column on a not-null violation', () => {
    const r = explainFailure({ code: '23502', message: 'null value in column "details" violates not-null constraint' })
    expect(r.message).toBe('A required field is missing: details.')
  })

  it('explains a foreign-key violation as a missing linked record', () => {
    const r = explainFailure({ code: '23503', message: 'insert violates foreign key constraint' })
    expect(r.message).toMatch(/linked record is missing/i)
  })

  it('explains a check violation', () => {
    const r = explainFailure({ code: '23514', message: 'new row violates check constraint "x"' })
    expect(r.message).toMatch(/isn’t allowed/i)
  })

  it('surfaces the real message for an unknown error code (R099 — no generic hiding)', () => {
    const r = explainFailure({ code: 'XX000', message: 'connection reset by peer' })
    expect(r.message).toBe('connection reset by peer')
  })

  it('falls back gracefully when there is no useful message', () => {
    const r = explainFailure({})
    expect(r.message).toMatch(/something went wrong/i)
  })

  it('handles a thrown Error object', () => {
    const r = explainFailure(new Error('boom'))
    expect(r.message).toBe('boom')
  })

  // Regression: the action-board "Follow up" bug. supabase-js returns a failed write
  // as a PLAIN object (not an Error instance) in the {data,error} tuple. The route used
  // to do String(err) on it -> "[object Object]". This is the exact shape Postgres
  // returns when message_actions.action_type rejected a non-legacy column slug.
  it('turns the raw PostgREST check-violation object into a readable reason (never [object Object])', () => {
    const pgrstError = {
      code: '23514',
      message:
        'new row for relation "message_actions" violates check constraint "message_actions_action_type_check"',
      details: null,
      hint: null,
    }
    const r = explainFailure(pgrstError)
    expect(r.message).not.toMatch(/\[object Object\]/)
    expect(r.message).toMatch(/isn’t allowed/i)
    expect(r.technical).toMatch(/message_actions_action_type_check/)
  })
})
