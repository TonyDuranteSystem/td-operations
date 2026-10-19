/**
 * "Fix spelling" — used when WE wrote a company's name wrongly: type the right name, the company and its storage top folder are renamed to
 * match, no previous name, no archive. No limit on how different the right name is. The pen is locked (the message points here).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

let account: Record<string, unknown> | null
let ownerRow: Record<string, unknown> | null
let updateResult: { data: Array<{ id: string }> | null; error: unknown }
let updates: Array<Record<string, unknown>>
const rpcMock = vi.fn()
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    rpc: (...a: unknown[]) => rpcMock(...a),
    from: (table: string) => {
      let patch: Record<string, unknown> | null = null
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.update = (p: Record<string, unknown>) => { patch = p; return c }
      c.eq = () => c
      c.maybeSingle = () => Promise.resolve({ data: table === 'accounts' ? account : table === 'store_owners' ? ownerRow : null, error: null })
      c.then = (resolve: (v: unknown) => void) => {
        if (patch) { updates.push(patch); return resolve('company_name' in patch ? updateResult : { data: null, error: null }) }
        return resolve({ data: null, error: null })
      }
      return c
    },
  },
}))
vi.mock('@/lib/crm-store/formation-pilot', () => ({ storeSafeFolderName: (n: string) => n.trim() }))

import { spellingFixProblem, fixCompanyNameSpelling } from '@/lib/operations/account-name-spelling'

describe('spellingFixProblem — only empty, unchanged and huge input are refused', () => {
  it('accepts ANY right name, however different (no letter limit)', () => {
    expect(spellingFixProblem('Acmee Trading LLC', 'Acme Trading LLC')).toBeNull()
    expect(spellingFixProblem('Acme', 'Acme Holdings LLC')).toBeNull()
    expect(spellingFixProblem('DF Commerce LLC', 'Growthlane Marketing LLC')).toBeNull()
    expect(spellingFixProblem('AB LLC', 'Totally Other Name LLC')).toBeNull()
  })
  it('refuses empty, unchanged and huge input', () => {
    expect(spellingFixProblem('Acme Trading LLC', '   ')).toMatch(/Type the correct name/)
    expect(spellingFixProblem('Acme Trading LLC', 'Acme Trading LLC')).toMatch(/already the name/)
    expect(spellingFixProblem('Acme Trading LLC', 'x'.repeat(201))).toMatch(/too long/)
  })
})

describe('fixCompanyNameSpelling', () => {
  beforeEach(() => {
    account = { company_name: 'Acme Holding LLC', notes: 'earlier' }
    ownerRow = { id: 'owner1' }
    updateResult = { data: [{ id: 'a1' }], error: null }
    updates = []
    rpcMock.mockReset()
    rpcMock.mockResolvedValue({ data: true, error: null })
  })
  const go = (newName = 'Zeta Partners LLC') => fixCompanyNameSpelling({ accountId: 'a1', newName, actor: 'dashboard:luca' })

  it('renames the company and its storage top folder to the name typed, and notes it — no previous name, no archive', async () => {
    const r = await go()
    expect(r).toMatchObject({ ok: true, oldName: 'Acme Holding LLC', newName: 'Zeta Partners LLC', folderRenamed: true })
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith('store_rename_root', { p_owner_id: 'owner1', p_name: 'Zeta Partners LLC', p_actor: null })
    expect(updates.find((u) => 'company_name' in u)).toEqual({ company_name: 'Zeta Partners LLC' })
    expect(updates.some((u) => 'previous_name' in u || 'name_history' in u)).toBe(false)
    expect(String(updates.find((u) => 'notes' in u)?.notes)).toContain('earlier')
    expect(String(updates.find((u) => 'notes' in u)?.notes)).toContain('corrected from "Acme Holding LLC" to "Zeta Partners LLC"')
  })

  it('a company without storage is just renamed', async () => {
    ownerRow = null
    expect(await go()).toMatchObject({ ok: true, folderRenamed: false })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('refuses an empty or unchanged name before touching anything', async () => {
    expect((await go('   ')).ok).toBe(false)
    expect((await go('Acme Holding LLC')).ok).toBe(false)
    expect(rpcMock).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('if the folder cannot be renamed nothing changes', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'nope' } })
    const r = await go()
    expect(r.ok).toBe(false)
    expect(updates).toHaveLength(0)
  })

  it('if the name changed meanwhile the folder is put back and the edit refused', async () => {
    updateResult = { data: [], error: null }
    const r = await go()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/changed while you were editing/)
    expect(rpcMock).toHaveBeenCalledTimes(2)
    expect(rpcMock).toHaveBeenLastCalledWith('store_rename_root', { p_owner_id: 'owner1', p_name: 'Acme Holding LLC', p_actor: null })
  })

  it('an unknown company is refused', async () => {
    account = null
    expect((await go()).error).toMatch(/not found/)
  })
})

describe('wiring', () => {
  it('the pen on the company name is locked with the short message, and the Fix spelling button sits beside it', () => {
    const src = read('components/accounts/account-detail.tsx')
    expect(src).toContain('lockedMessage="Please use Fix spelling (next to the name)."')
    expect(src).toContain('<FixSpellingButton accountId={account.id} currentName={account.company_name} />')
    const field = read('components/accounts/editable-field.tsx')
    expect(field).toContain('onLockedClick?.(lockedMessage)')
    expect(field).toContain('aria-disabled="true"')
  })
  it('the server action is staff-only and uses the operation', () => {
    const src = read('app/(dashboard)/accounts/actions.ts')
    const at = src.indexOf('export async function fixAccountNameSpelling')
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, at + 900)
    expect(body).toContain('isStaffUser(user)')
    expect(body).toContain('fixCompanyNameSpelling')
  })
})
