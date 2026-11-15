import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BECAME_CLIENT_VALUES } from '@/lib/accounts/became-client'

const sql = readFileSync(join(process.cwd(), 'scripts/migrations/20261114-0400-account-became-client-how.sql'), 'utf8')
const undo = readFileSync(join(process.cwd(), 'scripts/migrations/20261114-0400-account-became-client-how.UNDO.sql'), 'utf8')
const code = sql.replace(/^--.*$/gm, '') // the SQL without its comments

describe('migration: account field "How they became our client"', () => {
  it('adds exactly the three columns, all optional', () => {
    for (const col of ['became_client_how text', 'became_client_how_checked_at timestamptz', 'became_client_how_checked_by text']) {
      expect(code).toContain(`ADD COLUMN IF NOT EXISTS ${col}`)
    }
    const added = code.slice(code.indexOf('ALTER TABLE public.accounts'), code.indexOf('COMMENT ON'))
    expect(added).not.toMatch(/NOT NULL/i)
    expect(added).not.toMatch(/DEFAULT/i)
  })

  it('guards the two values with a TRIGGER and no value-list CHECK (a CHECK on the shared sandbox turns every other session\'s CI red)', () => {
    expect(code).not.toMatch(/\bCHECK\b/i)
    expect(code).not.toMatch(/ADD CONSTRAINT/i)
    expect(code).toContain('CREATE TRIGGER trg_accounts_became_client_how_guard')
    const listed = [...code.matchAll(/NOT IN \(([^)]*)\)/g)][0]?.[1] ?? ''
    const values = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(values).toEqual([...BECAME_CLIENT_VALUES])
  })

  it('backfills the guess in the same order as the code: contract first, then Client Since', () => {
    const formed = code.indexOf("WHEN COALESCE(c.has_formation, false) AND NOT COALESCE(c.has_onboarding, false) THEN 'formed_by_us'")
    const onboarded = code.indexOf("WHEN COALESCE(c.has_onboarding, false) AND NOT COALESCE(c.has_formation, false) THEN 'onboarded'")
    const dates = code.indexOf("WHEN a.client_since IS NOT NULL THEN 'onboarded'")
    const otherwise = code.indexOf("ELSE 'formed_by_us'")
    expect(formed).toBeGreaterThan(-1)
    expect(onboarded).toBeGreaterThan(formed)
    expect(dates).toBeGreaterThan(onboarded)
    expect(otherwise).toBeGreaterThan(dates)
  })

  it('only guesses for active, real client companies that have no value yet, and never marks anything as checked', () => {
    expect(code).toContain('a.became_client_how IS NULL')
    expect(code).toContain("a.account_type = 'Client'")
    expect(code).toContain("a.status = 'Active'")
    expect(code).toContain('COALESCE(a.is_test, false) = false')
    const backfill = code.slice(code.indexOf('UPDATE public.accounts a'))
    expect(backfill).not.toMatch(/checked_at|checked_by/)
  })

  it('touches nothing but the accounts table', () => {
    expect(code.match(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+public\.(\w+)/g)).toEqual(['UPDATE public.accounts'])
  })

  it('has an UNDO that drops the trigger, the function and the three columns', () => {
    expect(undo).toContain('DROP TRIGGER IF EXISTS trg_accounts_became_client_how_guard')
    expect(undo).toContain('DROP FUNCTION IF EXISTS public.guard_accounts_became_client_how()')
    for (const col of ['became_client_how_checked_by', 'became_client_how_checked_at', 'became_client_how']) {
      expect(undo).toContain(`DROP COLUMN IF EXISTS ${col}`)
    }
  })
})
