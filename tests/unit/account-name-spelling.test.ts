/**
 * "Fix spelling" — the only hand edit of a company's name (the pen is locked): a typo of at most two letters (or capitals/spacing),
 * the storage top folder follows, no previous name, no archive. A real new name is refused. Pure rules + the operation against fakes + wiring.
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

import { editDistance, spellingFixProblem, fixCompanyNameSpelling, NOT_A_SPELLING_FIX } from '@/lib/operations/account-name-spelling'

describe('editDistance', () => {
  it('counts single-letter inserts, deletes and replacements', () => {
    expect(editDistance('acme', 'acme')).toBe(0)
    expect(editDistance('acmee', 'acme')).toBe(1)
    expect(editDistance('acme', 'acne')).toBe(1)
    expect(editDistance('acme trading', 'acme tradng')).toBe(1)
    expect(editDistance('abc', 'xyz')).toBe(3)
    expect(editDistance('', 'abc')).toBe(3)
  })
})

describe('spellingFixProblem', () => {
  it('accepts a one- or two-letter typo and a capitals / spacing fix', () => {
    expect(spellingFixProblem('Acmee Trading LLC', 'Acme Trading LLC')).toBeNull()
    expect(spellingFixProblem('Acme Tradng LLC', 'Acme Trading LLC')).toBeNull()
    expect(spellingFixProblem('Acme Trdng LLC', 'Acme Trading LLC')).toBeNull() // two letters
    expect(spellingFixProblem('ACME TRADING LLC', 'Acme Trading LLC')).toBeNull()
    expect(spellingFixProblem('Acme  Trading LLC', 'Acme Trading LLC')).toBeNull()
  })
  it('refuses a real new name (more than two letters)', () => {
    expect(spellingFixProblem('Acme Trading LLC', 'Zeta Holdings LLC')).toBe(NOT_A_SPELLING_FIX)
    expect(spellingFixProblem('Acme Trading LLC', 'Acme Tradings Group LLC')).toBe(NOT_A_SPELLING_FIX)
  })
  it('refuses very short names, where two letters make a different company', () => {
    expect(spellingFixProblem('AB LLC', 'AC LLC')).toMatch(/too short/)
    expect(spellingFixProblem('Zed LLC', 'Zid LLC')).toMatch(/too short/)
  })
  it('a name under ten letters tolerates only ONE letter; a longer one two', () => {
    expect(spellingFixProblem('Solar Co LLC', 'Solar Cx LLC')).toBeNull() // one letter, 8-letter base
    expect(spellingFixProblem('Solar Co LLC', 'Sular Cx LLC')).toBe(NOT_A_SPELLING_FIX) // two letters, 8-letter base
    expect(spellingFixProblem('Solar Group LLC', 'Sular Grop LLC')).toBeNull() // two letters, 11-letter base
  })
  it('refuses empty, unchanged and huge input', () => {
    expect(spellingFixProblem('Acme Trading LLC', '   ')).toMatch(/Type the corrected name/)
    expect(spellingFixProblem('Acme Trading LLC', 'Acme Trading LLC')).toMatch(/already the name/)
    expect(spellingFixProblem('Acme Trading LLC', 'x'.repeat(201))).toMatch(/too long/)
  })
  it('the trailing LLC is not counted as letters that changed', () => {
    // "Acme Trading" → "Acme Trading LLC": the ending itself counts as ONE letter, not four
    expect(spellingFixProblem('Acme Trading', 'Acme Trading LLC')).toBeNull()
    expect(spellingFixProblem('Acme Trading LLC', 'Acme Trading')).toBeNull()
    // …but a suffix plus a typo is already two, and a different base is still refused
    expect(spellingFixProblem('Acme Tradng', 'Acme Trading LLC')).toBeNull()
    expect(spellingFixProblem('Acme Trading', 'Zeta Holdings LLC')).toBe(NOT_A_SPELLING_FIX)
  })
})

describe('fixCompanyNameSpelling', () => {
  beforeEach(() => {
    account = { company_name: 'Acmee Trading LLC', notes: 'earlier' }
    ownerRow = { id: 'owner1' }
    updateResult = { data: [{ id: 'a1' }], error: null }
    updates = []
    rpcMock.mockReset()
    rpcMock.mockResolvedValue({ data: true, error: null })
  })
  const go = (newName = 'Acme Trading LLC') => fixCompanyNameSpelling({ accountId: 'a1', newName, actor: 'dashboard:luca' })

  it('renames the company and its storage top folder, and notes it — no previous name, no archive', async () => {
    const r = await go()
    expect(r).toMatchObject({ ok: true, oldName: 'Acmee Trading LLC', newName: 'Acme Trading LLC', folderRenamed: true })
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith('store_rename_root', { p_owner_id: 'owner1', p_name: 'Acme Trading LLC', p_actor: null })
    expect(updates.find((u) => 'company_name' in u)).toEqual({ company_name: 'Acme Trading LLC' })
    expect(updates.some((u) => 'previous_name' in u || 'name_history' in u)).toBe(false)
    expect(String(updates.find((u) => 'notes' in u)?.notes)).toContain('spelling corrected from "Acmee Trading LLC" to "Acme Trading LLC"')
  })

  it('a company without storage is just renamed', async () => {
    ownerRow = null
    expect(await go()).toMatchObject({ ok: true, folderRenamed: false })
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('refuses a real new name before touching anything', async () => {
    const r = await go('Zeta Holdings LLC')
    expect(r).toEqual({ ok: false, error: NOT_A_SPELLING_FIX })
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
    expect(rpcMock).toHaveBeenLastCalledWith('store_rename_root', { p_owner_id: 'owner1', p_name: 'Acmee Trading LLC', p_actor: null })
  })

  it('an unknown company is refused', async () => {
    account = null
    expect((await go()).error).toMatch(/not found/)
  })
})

describe('wiring', () => {
  it('the pen on the company name is locked with the message, and the Fix spelling button sits beside it', () => {
    const src = read('components/accounts/account-detail.tsx')
    expect(src).toContain('lockedMessage="Please use Fix spelling (next to the name).')
    expect(src).toContain('<FixSpellingButton accountId={account.id} currentName={account.company_name} />')
    const field = read('components/accounts/editable-field.tsx')
    expect(field).toContain('onLockedClick?.(lockedMessage)')
    expect(field).toContain('aria-disabled="true"')
  })
  it('the server action is staff-only and uses the spelling operation', () => {
    const src = read('app/(dashboard)/accounts/actions.ts')
    const at = src.indexOf('export async function fixAccountNameSpelling')
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, at + 900)
    expect(body).toContain('isStaffUser(user)')
    expect(body).toContain('fixCompanyNameSpelling')
  })
})
