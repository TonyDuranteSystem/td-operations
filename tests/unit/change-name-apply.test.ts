/**
 * Company Change Name, "Apply the new name" (dev job bb64c417, track B3): the one staff action that renames the company and moves its old
 * folders. Pure guard rules + the operation against fakes + wiring checks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHANGE_NAME_STAGES } from '@/lib/flows/change-name-stages'
import { STAGE_COMPONENT_TYPES } from '@/lib/flows/stage-layout'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

// ── fakes ──
let sd: Record<string, unknown> | null
let account: Record<string, unknown> | null
let docCount: number
let leaseCount: number
let noteUpdates: Array<Record<string, unknown>>
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let wantsCount = false
      let isUpdate: Record<string, unknown> | null = null
      const c: Record<string, unknown> = {}
      c.select = (_cols?: string, opts?: { count?: string }) => { wantsCount = !!opts?.count; return c }
      c.update = (patch: Record<string, unknown>) => { isUpdate = patch; return c }
      c.eq = () => c
      c.in = () => c
      c.maybeSingle = () => Promise.resolve({ data: table === 'service_deliveries' ? sd : table === 'accounts' ? account : null, error: null })
      c.then = (resolve: (v: unknown) => void) => {
        if (isUpdate) { noteUpdates.push(isUpdate); return resolve({ data: null, error: null }) }
        if (wantsCount) return resolve({ count: table === 'documents' ? docCount : table === 'lease_agreements' ? leaseCount : 0, error: null })
        return resolve({ data: null, error: null })
      }
      return c
    },
  },
}))
const applyMock = vi.fn()
vi.mock('@/lib/operations/account-name-change', () => ({ applyAccountNameChange: (...a: unknown[]) => applyMock(...a) }))

import { applyNameBlockers, typedNameDiffersFromFiled, getApplyNameState, applyNewName } from '@/lib/operations/change-name-apply'

const ready = { serviceType: 'Company Change Name', jobStatus: 'active', stage: CHANGE_NAME_STAGES.records, filedName: 'Acme Holdings', hasStampedDocument: true, openLeaseCount: 0, alreadyApplied: false }

describe('applyNameBlockers', () => {
  it('nothing blocks a job on the records step with a filed name, the stamped document and no open lease', () => {
    expect(applyNameBlockers(ready)).toEqual([])
  })
  it('each missing piece is its own plain reason', () => {
    expect(applyNameBlockers({ ...ready, stage: CHANGE_NAME_STAGES.wait }).join(' ')).toMatch(/Update our records/)
    expect(applyNameBlockers({ ...ready, filedName: null }).join(' ')).toMatch(/filed/)
    expect(applyNameBlockers({ ...ready, hasStampedDocument: false }).join(' ')).toMatch(/stamped document/)
    expect(applyNameBlockers({ ...ready, openLeaseCount: 2 }).join(' ')).toMatch(/lease.*2 found/)
    expect(applyNameBlockers({ ...ready, jobStatus: 'completed' }).join(' ')).toMatch(/not active/)
  })
  it('another service is refused; an already applied change has nothing left to block', () => {
    expect(applyNameBlockers({ ...ready, serviceType: 'Company Formation' })).toEqual(['This is not a Company Change Name job.'])
    expect(applyNameBlockers({ ...ready, stage: CHANGE_NAME_STAGES.done, filedName: null, hasStampedDocument: false, alreadyApplied: true })).toEqual([])
  })
})

describe('typedNameDiffersFromFiled', () => {
  it('capitals, commas, periods and a trailing LLC do not count', () => {
    expect(typedNameDiffersFromFiled('ACME HOLDINGS, LLC', 'Acme Holdings')).toBe(false)
    expect(typedNameDiffersFromFiled('Acme Holdings LLC', 'Acme Holdings LLC')).toBe(false)
  })
  it('a different name does', () => {
    expect(typedNameDiffersFromFiled('Acme Trading LLC', 'Acme Holdings')).toBe(true)
    expect(typedNameDiffersFromFiled('Acme Holdings LLC', null)).toBe(true)
  })
})

describe('applyNewName', () => {
  beforeEach(() => {
    sd = { id: 'sd1', service_type: 'Company Change Name', status: 'active', stage: CHANGE_NAME_STAGES.records, account_id: 'a1', name_checks: [{ name: 'Acme Holdings', status: 'filed', source: 'wizard', updated_at: null }] }
    account = { id: 'a1', company_name: 'Old Name LLC', name_history: [], notes: 'earlier note' }
    docCount = 1
    leaseCount = 0
    noteUpdates = []
    applyMock.mockReset()
    applyMock.mockResolvedValue({ status: 'applied', account_id: 'a1', old_name: 'Old Name LLC', new_name: 'Acme Holdings LLC', storage: { status: 'applied' } })
  })
  const go = (over: Partial<Parameters<typeof applyNewName>[0]> = {}) => applyNewName({ sdId: 'sd1', typedName: 'Acme Holdings LLC', actorId: 'u1', actorLabel: 'Luca', ...over })

  it('applies the name through the database function once, with the job as the change id, and notes it on the company', async () => {
    const r = await go()
    expect(r).toMatchObject({ ok: true, oldName: 'Old Name LLC', newName: 'Acme Holdings LLC' })
    expect(applyMock).toHaveBeenCalledWith({ accountId: 'a1', changeId: 'sd1', newName: 'Acme Holdings LLC', expectedOldName: 'Old Name LLC', actor: 'u1' })
    expect(noteUpdates).toHaveLength(1)
    expect(String(noteUpdates[0].notes)).toContain('earlier note')
    expect(String(noteUpdates[0].notes)).toContain('renamed from "Old Name LLC" to "Acme Holdings LLC"')
  })

  it('refuses until the state document is in, a name is filed and no lease is open — nothing is renamed', async () => {
    docCount = 0
    expect((await go()).error).toMatch(/stamped document/)
    docCount = 1; leaseCount = 1
    expect((await go()).error).toMatch(/lease/)
    leaseCount = 0; sd = { ...(sd as object), stage: CHANGE_NAME_STAGES.wait }
    expect((await go()).error).toMatch(/Update our records/)
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('a typed name that is not the filed one needs an explicit confirmation', async () => {
    const r = await go({ typedName: 'Acme Trading LLC' })
    expect(r.ok).toBe(false)
    expect(r.mismatch).toEqual({ typed: 'Acme Trading LLC', filed: 'Acme Holdings' })
    expect(applyMock).not.toHaveBeenCalled()
    const ok = await go({ typedName: 'Acme Trading LLC', confirmMismatch: true })
    expect(ok.ok).toBe(true)
    expect(applyMock).toHaveBeenCalledTimes(1)
  })

  it('a blank or huge name is refused before anything is read', async () => {
    expect((await go({ typedName: '   ' })).ok).toBe(false)
    expect((await go({ typedName: 'x'.repeat(201) })).ok).toBe(false)
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('a second click after it was applied changes nothing', async () => {
    account = { ...(account as object), company_name: 'Acme Holdings LLC', name_history: [{ type: 'change', change_id: 'sd1', old_name: 'Old Name LLC', new_name: 'Acme Holdings LLC' }] }
    const r = await go()
    expect(r).toMatchObject({ ok: true, alreadyApplied: true, oldName: 'Old Name LLC', newName: 'Acme Holdings LLC' })
    expect(applyMock).not.toHaveBeenCalled()
    expect(noteUpdates).toHaveLength(0)
    // …but an UNDONE change can be applied again
    account = { ...(account as object), name_history: [{ type: 'change', change_id: 'sd1' }, { type: 'undo', change_id: 'sd1' }] }
    expect((await getApplyNameState('sd1')).applied).toBeNull()
  })

  it('the database refusing (case-only change, storage in an unexpected shape, an upload running…) comes back as a plain message', async () => {
    applyMock.mockRejectedValue(new Error('the new name differs only by capital letters or spacing'))
    expect(await go()).toMatchObject({ ok: false, error: 'the new name differs only by capital letters or spacing' })
  })

  it('a company renamed by someone else meanwhile is a conflict, not an overwrite', async () => {
    applyMock.mockResolvedValue({ status: 'conflict', account_id: 'a1', current_name: 'Third Name LLC' })
    expect((await go()).error).toMatch(/Third Name LLC/)
    expect(noteUpdates).toHaveLength(0)
  })

  it('only a Company Change Name job can be applied', async () => {
    sd = { ...(sd as object), service_type: 'Company Formation' }
    expect((await getApplyNameState('sd1')).ok).toBe(false)
  })
})

describe('wiring', () => {
  it('the panel is a layout component, rendered by the stage renderer, on step 6 of the catalog migration', () => {
    expect(STAGE_COMPONENT_TYPES as readonly string[]).toContain('apply_name_panel')
    expect(read('components/flows/stage-renderer.tsx')).toContain("case 'apply_name_panel':")
    const sql = read('scripts/migrations/20261019-1000-change-name-8-steps.sql')
    expect(sql).toContain('{"type":"apply_name_panel"}')
  })
  it('the route is staff-only and passes the signed-in user as the actor', () => {
    const src = read('app/api/flows/[id]/apply-new-name/route.ts')
    expect(src.match(/requireStaffRoute\(\)/g)).toHaveLength(2)
    expect(src).toContain('actorId: user.id')
  })
  it('the portal matches tax returns by company (account_id), never by the name that a rename changes', () => {
    const q = read('lib/portal/queries.ts')
    expect(q).not.toContain(".eq('company_name', acct.company_name)")
    expect(q).not.toContain(".eq('company_name', account.company_name)")
    expect(q).not.toContain(".eq('company_name', acctForTax.company_name)")
    expect(q.match(/\.from\('tax_returns'\)[\s\S]{0,260}\.eq\('account_id', accountId\)/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
