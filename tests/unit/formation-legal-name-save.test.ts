/**
 * Job 80cce1cb — saveConfirmedLegalName: the legal name staff confirmed on the Articles window is saved on the FILED name before the
 * advance, so a retry / the stepper / a tool create the same company name. And the client-card refusal of non-LLC names.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sd: null as Record<string, unknown> | null,
  writes: [] as Array<{ name_checks: unknown; expected: string | null }>,
  writeOk: true,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== 'service_deliveries') {
        const empty: Record<string, unknown> = { select: () => empty, eq: () => empty, in: () => empty, order: () => empty, limit: () => empty, maybeSingle: () => Promise.resolve({ data: null, error: null }) }
        return empty
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: h.sd, error: null }),
        update: (row: Record<string, unknown>) => {
          let expected: string | null = null
          const upd: Record<string, unknown> = {
            eq: (col: string, val: string) => {
              if (col === 'updated_at') expected = val
              return upd
            },
            select: () => {
              h.writes.push({ name_checks: row.name_checks, expected })
              return Promise.resolve({ data: h.writeOk ? [{ id: 'sd-1' }] : [], error: null })
            },
          }
          return upd
        },
      }
      return chain
    },
  },
}))
vi.mock('@/lib/operations/decision-request', () => ({ createDecisionRequest: vi.fn(async () => ({ ok: true, id: 'req-1' })) }))
vi.mock('@/lib/portal/notifications', () => ({ notifyClientOfAdminMessage: vi.fn() }))
vi.mock('@/lib/formation/state-lookup', () => ({ formationStateForClient: vi.fn(async () => 'NM') }))

import { saveConfirmedLegalName, handleNameAction } from '@/lib/operations/formation-name-checks'

const sd = (over: Record<string, unknown> = {}) => ({
  id: 'sd-1',
  contact_id: 'c-1',
  account_id: null,
  service_type: 'Company Formation',
  name_checks: [
    { name: 'Tanto per', source: 'wizard', status: 'filed', updated_at: '2026-10-20T13:55:06.800Z' },
    { name: 'Sottovoce', source: 'wizard', status: 'pending', updated_at: null },
  ],
  due_date: null,
  stage_entered_at: null,
  created_at: '2026-10-19T00:00:00Z',
  stage: 'Filed with State',
  updated_at: '2026-10-27T12:00:00.000Z',
  status: 'active',
  ...over,
})

beforeEach(() => {
  h.sd = sd()
  h.writes = []
  h.writeOk = true
})

describe('saveConfirmedLegalName', () => {
  it('writes the confirmed name onto the FILED entry only, with the version guard', async () => {
    const r = await saveConfirmedLegalName({ sdId: 'sd-1', legalName: 'Tanto Per LLC' })
    expect(r).toEqual({ ok: true, saved: true })
    expect(h.writes).toHaveLength(1)
    const saved = h.writes[0].name_checks as Array<Record<string, unknown>>
    expect(saved[0]).toMatchObject({ name: 'Tanto per', status: 'filed', legal_name: 'Tanto Per LLC' })
    expect(saved[1].legal_name).toBeUndefined()
    expect(h.writes[0].expected).toBe('2026-10-27T12:00:00.000Z') // guarded by the version it read
  })

  it('writes nothing when the same name is already saved', async () => {
    h.sd = sd({ name_checks: [{ name: 'Tanto per', source: 'wizard', status: 'filed', updated_at: null, legal_name: 'Tanto Per LLC' }] })
    expect(await saveConfirmedLegalName({ sdId: 'sd-1', legalName: 'Tanto Per LLC' })).toEqual({ ok: true, saved: true })
    expect(h.writes).toHaveLength(0)
  })

  it('nothing filed yet (the wizard-name fallback) -> nothing to attach to, not an error', async () => {
    h.sd = sd({ name_checks: [{ name: 'Tanto per', source: 'wizard', status: 'available', updated_at: null }] })
    expect(await saveConfirmedLegalName({ sdId: 'sd-1', legalName: 'Tanto Per LLC' })).toEqual({ ok: true, saved: false })
    expect(h.writes).toHaveLength(0)
  })

  it('refused once the company exists (a rename after that is "Fix spelling")', async () => {
    h.sd = sd({ account_id: 'acct-1' })
    const r = await saveConfirmedLegalName({ sdId: 'sd-1', legalName: 'Tanto Per LLC' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Fix spelling')
    expect(h.writes).toHaveLength(0)
  })

  it('refused for any service but Company Formation', async () => {
    h.sd = sd({ service_type: 'Company Change Name' })
    expect((await saveConfirmedLegalName({ sdId: 'sd-1', legalName: 'X LLC' })).ok).toBe(false)
  })

  it('a stale tab (someone changed the case meanwhile) is a plain error, not an overwrite', async () => {
    h.writeOk = false
    const r = await saveConfirmedLegalName({ sdId: 'sd-1', legalName: 'Tanto Per LLC' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('changed while you were working')
  })

  it('unknown case', async () => {
    h.sd = null
    expect(await saveConfirmedLegalName({ sdId: 'nope', legalName: 'X LLC' })).toEqual({ ok: false, error: 'Flow not found.' })
  })
})

describe('send_to_client — a formation name that cannot be an LLC name is refused before the client sees it', () => {
  it('"Pinnacle Corp" is refused with the plain sentence and nothing is reserved or sent', async () => {
    h.sd = sd({
      stage: 'Wizard Submitted',
      name_checks: [{ name: 'Pinnacle Corp', source: 'wizard', status: 'available', updated_at: null }],
    })
    const r = await handleNameAction({ sdId: 'sd-1', action: 'send_to_client', nameIndex: 0, actor: 'luca' } as never)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('not an LLC ending')
    expect(h.writes).toHaveLength(0)
  })
})
