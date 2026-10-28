/**
 * Dev job e3215801 — the record that a document was filed in Storage on purpose while a workspace step was waiting for it
 * (shared by the Storage upload route and the contact page's upload route).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, error: false, throws: false }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        if (fx.throws) throw new Error('exploded')
        if (!fx.error) fx.rows.push(row)
        return Promise.resolve({ error: fx.error ? { message: 'db down' } : null })
      },
    }),
  },
}))

import { recordStorageOnlyFiling } from '@/lib/flows/storage-step-log'

const HIT = {
  sdId: 'sd-1', serviceType: 'ITIN', stage: 'IRS Processing', who: 'Maria Rossi', asks: 'the IRS approval letter (CP565)', matchedBy: 'type' as const,
  how: 'x', storageDoes: [], workspaceDoes: ['close the case'], workspacePath: '/flows/sd-1', contactId: 'c-1', accountId: null as string | null,
}
const base = { actorEmail: 'luca@tonydurante.us', fileId: 'store:file-1', fileName: 'letter.pdf', documentType: 'itin_letter' }

beforeEach(() => { fx.rows = []; fx.error = false; fx.throws = false })

describe('recordStorageOnlyFiling', () => {
  it('writes one record per waiting case, tied to the case AND the person, by the staff member', async () => {
    expect(await recordStorageOnlyFiling({ ...base, waiting: [HIT, { ...HIT, sdId: 'sd-2', accountId: 'a-1' }] })).toBe('recorded')
    expect(fx.rows).toHaveLength(2)
    expect(fx.rows[0]).toMatchObject({ actor: 'dashboard:luca', action_type: 'storage_filed_workspace_document', service_delivery_id: 'sd-1', contact_id: 'c-1', account_id: null, record_id: 'store:file-1' })
    expect(fx.rows[1]).toMatchObject({ service_delivery_id: 'sd-2', account_id: 'a-1' })
    expect(String(fx.rows[0].summary)).toBe('The IRS approval letter (CP565) filed in Storage only — Maria Rossi\'s ITIN case is still at "IRS Processing" (the workspace step was not done)')
  })

  it('a file only typed "Other document" is logged as exactly that — never as "the IRS letter"', async () => {
    await recordStorageOnlyFiling({ ...base, documentType: 'other_document', waiting: [{ ...HIT, matchedBy: 'folder' }] })
    const s = String(fx.rows[0].summary)
    expect(s).toContain('A file typed "Other document"')
    expect(s).toContain('waiting for the IRS approval letter (CP565)')
    expect(s).not.toContain('filed in Storage only —')
    expect((fx.rows[0].details as Record<string, unknown>).matched_by).toBe('folder')
  })

  it('a note that cannot be written (error OR exception) answers "failed" — it never throws, so the save is never undone', async () => {
    fx.error = true
    expect(await recordStorageOnlyFiling({ ...base, waiting: [HIT] })).toBe('failed')
    fx.error = false
    fx.throws = true
    expect(await recordStorageOnlyFiling({ ...base, waiting: [HIT] })).toBe('failed')
  })

  it('an unknown actor is still recorded (as "unknown"), and nothing waiting writes nothing', async () => {
    await recordStorageOnlyFiling({ ...base, actorEmail: null, waiting: [HIT] })
    expect(fx.rows[0].actor).toBe('dashboard:unknown')
    fx.rows = []
    expect(await recordStorageOnlyFiling({ ...base, waiting: [] })).toBe('recorded')
    expect(fx.rows).toHaveLength(0)
  })
})
