/**
 * Company Change Name, step 7 — the new Operating Agreement (dev job bb64c417, track B4). The old signed agreement is KEPT; the
 * client generates a new version with the new name; signing it closes the job. Pure rules + source-level wiring checks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isNameChangeNewVersion, oaNameKey, uniqueOaToken, hasCollectedSignatures, previousNameForNewOa } from '@/lib/portal/oa-regenerate-guard'
import { generateOASections, type OAData } from '@/lib/types/oa-templates'
import { signedOaClosesNameChange, advanceNameChangeAfterOaSigned } from '@/lib/oa/name-change-advance'
import { actionStageConfigFor, resolveActionLink } from '@/lib/portal/action-stage-registry'
import { CHANGE_NAME_STAGES } from '@/lib/flows/change-name-stages'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

describe('isNameChangeNewVersion — a fully signed agreement under the OLD name allows a new version', () => {
  it('yes: newest is fully signed and its frozen name is not the company\'s name any more', () => {
    expect(isNameChangeNewVersion({ status: 'signed', company_name: 'Old Name LLC' }, 'New Name LLC')).toBe(true)
  })
  it('no: same name (capitals and spacing do not count) — the normal "already signed" refusal stays', () => {
    expect(isNameChangeNewVersion({ status: 'signed', company_name: 'Acme LLC' }, 'Acme LLC')).toBe(false)
    expect(isNameChangeNewVersion({ status: 'signed', company_name: 'ACME  llc ' }, 'acme LLC')).toBe(false)
  })
  it('no: a partly signed, sent, draft or voided agreement never qualifies (those keep today\'s rules)', () => {
    for (const status of ['partially_signed', 'sent', 'viewed', 'draft', 'voided', null]) {
      expect(isNameChangeNewVersion({ status, company_name: 'Old LLC' }, 'New LLC')).toBe(false)
    }
  })
  it('no: a missing name on either side cannot prove a rename', () => {
    expect(isNameChangeNewVersion({ status: 'signed', company_name: null }, 'New LLC')).toBe(false)
    expect(isNameChangeNewVersion({ status: 'signed', company_name: 'Old LLC' }, null)).toBe(false)
    expect(isNameChangeNewVersion({ status: 'signed', company_name: '' }, '')).toBe(false)
  })
  it('the old refusal still holds for the same signed agreement', () => {
    expect(hasCollectedSignatures({ status: 'signed' })).toBe(true)
  })
  it('oaNameKey', () => {
    expect(oaNameKey('  Acme   Holdings LLC ')).toBe('acme holdings llc')
    expect(oaNameKey(null)).toBe('')
  })
})

describe('previousNameForNewOa — "formerly known as"', () => {
  it('is the name on the most recent FULLY SIGNED agreement when the company has a different name now', () => {
    expect(previousNameForNewOa([{ status: 'signed', company_name: 'Old Name LLC' }], 'New Name LLC')).toBe('Old Name LLC')
    // newest first: the more recent signed name wins over an older one
    expect(previousNameForNewOa([{ status: 'signed', company_name: 'Second LLC' }, { status: 'signed', company_name: 'First LLC' }], 'Third LLC')).toBe('Second LLC')
  })
  it('survives a regenerate: the new unsigned agreement in the list does not hide it', () => {
    expect(previousNameForNewOa([{ status: 'sent', company_name: 'New Name LLC' }, { status: 'signed', company_name: 'Old Name LLC' }], 'New Name LLC')).toBe('Old Name LLC')
  })
  it('is null for an ordinary company, for capitals-only differences and for unsigned agreements', () => {
    expect(previousNameForNewOa([], 'Acme LLC')).toBeNull()
    expect(previousNameForNewOa([{ status: 'signed', company_name: 'ACME  llc' }], 'Acme LLC')).toBeNull()
    expect(previousNameForNewOa([{ status: 'sent', company_name: 'Other LLC' }, { status: 'voided', company_name: 'Another LLC' }], 'Acme LLC')).toBeNull()
    expect(previousNameForNewOa([{ status: 'signed', company_name: 'Old LLC' }], '')).toBeNull()
  })
})

describe('the agreement text', () => {
  const base: OAData = {
    company_name: 'New Name LLC', state_of_formation: 'Wyoming', formation_date: '2024-03-01', entity_type: 'SMLLC', member_name: 'Pat Doe',
    manager_name: 'Pat Doe', effective_date: '2026-10-19', business_purpose: 'any lawful business', initial_contribution: '$1,000 USD',
    fiscal_year_end: 'December 31', accounting_method: 'Cash', duration: 'Perpetual', principal_address: '1 Main St',
  }
  const text = (d: OAData) => generateOASections(d).map((x) => x.content).join('\n')
  it('says the company was formerly known as the old name — single-member and multi-member — only when a previous name is set', () => {
    for (const entity_type of ['SMLLC', 'MMLLC'] as const) {
      const d = { ...base, entity_type, members: [{ name: 'Pat Doe', ownership_pct: 100, initial_contribution: '$1,000 USD' }] }
      expect(text(d)).not.toContain('formerly known as')
      expect(text({ ...d, previous_company_name: 'Old Name LLC' })).toContain('The name of the Company is New Name LLC. The Company was formerly known as Old Name LLC.')
    }
  })
})

describe('uniqueOaToken', () => {
  it('keeps a free token and numbers a taken one', () => {
    expect(uniqueOaToken('acme-oa-2026', new Set())).toBe('acme-oa-2026')
    expect(uniqueOaToken('acme-oa-2026', new Set(['acme-oa-2026']))).toBe('acme-oa-2026-2')
    expect(uniqueOaToken('acme-oa-2026', new Set(['acme-oa-2026', 'acme-oa-2026-2']))).toBe('acme-oa-2026-3')
  })
})

describe('signedOaClosesNameChange', () => {
  const base = { serviceType: 'Company Change Name', jobStage: CHANGE_NAME_STAGES.oa, signedOaName: 'New LLC', accountName: 'New LLC' }
  it('closes when the job waits on the agreement step and the signed agreement carries the current name', () => {
    expect(signedOaClosesNameChange(base)).toBe(true)
    expect(signedOaClosesNameChange({ ...base, signedOaName: ' new  llc' })).toBe(true)
  })
  it('never closes on the OLD agreement (signed under the old name), another step, another service or a missing name', () => {
    expect(signedOaClosesNameChange({ ...base, signedOaName: 'Old LLC' })).toBe(false)
    expect(signedOaClosesNameChange({ ...base, jobStage: CHANGE_NAME_STAGES.records })).toBe(false)
    expect(signedOaClosesNameChange({ ...base, serviceType: 'Company Formation' })).toBe(false)
    expect(signedOaClosesNameChange({ ...base, signedOaName: null })).toBe(false)
    expect(signedOaClosesNameChange({ ...base, accountName: '' })).toBe(false)
  })
})

describe('the step-7 message to the client', () => {
  it('is registered for that step only, bilingual, and links to the right company\'s Generate Documents page', () => {
    const cfg = actionStageConfigFor('Company Change Name', CHANGE_NAME_STAGES.oa)!
    expect(cfg).toBeTruthy()
    expect(cfg.title.en).toMatch(/Operating Agreement/)
    expect(cfg.title.it).toMatch(/Operating Agreement/)
    expect(cfg.message.it).toMatch(/Genera Documenti/)
    expect(cfg.link).toBe('/portal/documents/generate?account={account_id}')
    for (const stage of [CHANGE_NAME_STAGES.sign, CHANGE_NAME_STAGES.records, CHANGE_NAME_STAGES.done]) {
      expect(actionStageConfigFor('Company Change Name', stage)).toBeNull()
    }
  })
  it('the dispatch and the stepper both fill in the tokens through one helper', () => {
    expect(read('lib/service-delivery.ts')).toContain('resolveActionLink(actionStageCfg.link, { sdId: delivery.id, accountId: delivery.account_id ?? null })')
    expect(read('lib/flows/flow-progress.ts')).toContain('resolveActionLink(actionConfig.link, { sdId, accountId })')
  })
  it('resolveActionLink fills {sd_id} and {account_id}, and drops the account part when no company is known (never a literal token)', () => {
    expect(resolveActionLink('/portal/flows/{sd_id}', { sdId: 'sd1' })).toBe('/portal/flows/sd1')
    expect(resolveActionLink('/portal/documents/generate?account={account_id}', { sdId: 'sd1', accountId: 'acc1' })).toBe('/portal/documents/generate?account=acc1')
    expect(resolveActionLink('/portal/documents/generate?account={account_id}', { sdId: 'sd1', accountId: null })).toBe('/portal/documents/generate')
    expect(resolveActionLink('/portal/wizard', { sdId: 'sd1', accountId: 'acc1' })).toBe('/portal/wizard')
  })
})

describe('wiring', () => {
  it('the create route lets a renamed company generate a new version and keeps the signed agreement', () => {
    const src = read('app/api/portal/operating-agreement/create/route.ts')
    expect(src).toContain('isNameChangeNewVersion(existing, account.company_name as string)')
    expect(src).toContain('if (!isRenameNewVersion) {')
    // the delete of the newest agreement and its signatures lives only inside the guarded block
    const guarded = src.indexOf('if (!isRenameNewVersion) {')
    const sweep = src.indexOf('Sweep every OTHER row')
    expect(guarded).toBeGreaterThan(0)
    expect(sweep).toBeGreaterThan(guarded)
    expect(src.slice(guarded, sweep)).toContain("from('oa_signatures').delete().eq('oa_id', existing.id)")
    // the sweep that follows never deletes a signed agreement
    expect(src.slice(sweep)).toContain("filter(o => o.status !== 'signed' && !o.signed_at)")
    expect(src).toContain('token: oaToken')
  })
  it('the two staff readers take the NEWEST agreement', () => {
    expect(read('app/api/crm/admin-actions/generate-document/route.ts')).toContain('.eq("account_id", accountId).order("created_at", { ascending: false }).limit(1)')
    expect(read('app/api/crm/admin-actions/place-client/route.ts')).toContain('.eq("account_id", accountId).order("created_at", { ascending: false }).limit(1)')
  })
  it('signing the new agreement closes the job, inside its own try/catch, only when fully signed', () => {
    const src = read('app/api/oa-signed/route.ts')
    const fully = src.indexOf('if (isFullySigned && oa.account_id) {')
    const hook = src.indexOf('advanceNameChangeAfterOaSigned')
    expect(fully).toBeGreaterThan(0)
    expect(hook).toBeGreaterThan(fully)
    expect(src.slice(hook - 200, hook)).toContain('try {')
  })
  it('every place that builds the agreement from its saved row prints the previous name, and the create route saves it', () => {
    for (const f of ['lib/oa/finalize-signing.ts', 'app/api/operating-agreement/[token]/pdf/route.ts', 'app/api/operating-agreement/[token]/hand-signed/route.ts']) {
      expect(read(f), f).toContain('previous_company_name: agreement.previous_company_name ?? undefined')
    }
    expect(read('app/operating-agreement/[token]/[code]/page.tsx')).toContain('previous_company_name: oa.previous_company_name || undefined')
    expect(read('lib/oa/public-view.ts')).toContain('"previous_company_name",')
    expect(read('lib/oa/public-view.ts')).toContain('previous_company_name: row.previous_company_name ?? null')
    expect(read('app/api/portal/operating-agreement/create/route.ts')).toContain('previous_company_name: previousCompanyName')
    expect(read('lib/pdf/operating-agreement-pdf.ts')).toContain('(formerly known as $' + '{data.previous_company_name})')
    expect(read('scripts/migrations/20261019-1600-oa-previous-company-name.sql')).toContain('ADD COLUMN IF NOT EXISTS previous_company_name text')
  })
  it('the Generate Documents page honours ?account= only for the client\'s own companies', () => {
    const src = read('app/portal/documents/generate/page.tsx')
    expect(src).toContain('accounts.find(a => a.id === searchParams.account)?.id')
    expect(src).toContain('requestedAccountId ?? accounts.find(a => a.id === cookieAccountId)')
  })
})

// ── advanceNameChangeAfterOaSigned against fakes ──
let account: { company_name: string } | null = null
let job: Record<string, unknown> | null = null
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.limit = () => c
      c.maybeSingle = () => Promise.resolve({ data: table === 'accounts' ? account : table === 'service_deliveries' ? job : null, error: null })
      return c
    },
  },
}))
const advanceMock = vi.fn()
vi.mock('@/lib/service-delivery', () => ({ advanceServiceDelivery: (...a: unknown[]) => advanceMock(...a) }))
const reportMock = vi.fn().mockResolvedValue(null)
vi.mock('@/lib/system-errors', () => ({ reportSystemError: (...a: unknown[]) => reportMock(...a) }))

describe('advanceNameChangeAfterOaSigned', () => {
  beforeEach(() => {
    account = { company_name: 'New LLC' }
    job = { id: 'sd-1', service_type: 'Company Change Name', stage: CHANGE_NAME_STAGES.oa }
    advanceMock.mockReset()
    advanceMock.mockResolvedValue({ success: true })
    reportMock.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  it('closes the job when the new agreement is signed', async () => {
    const r = await advanceNameChangeAfterOaSigned({ accountId: 'a1', oaId: 'oa1', signedOaName: 'New LLC' })
    expect(r).toEqual({ advanced: true })
    expect(advanceMock).toHaveBeenCalledWith(expect.objectContaining({ delivery_id: 'sd-1', target_stage: 'Completed', skip_tasks: true }))
  })
  it('leaves the job alone for the old agreement, or when no job waits on this step', async () => {
    expect((await advanceNameChangeAfterOaSigned({ accountId: 'a1', oaId: 'oa0', signedOaName: 'Old LLC' })).advanced).toBe(false)
    job = null
    expect((await advanceNameChangeAfterOaSigned({ accountId: 'a1', oaId: 'oa1', signedOaName: 'New LLC' })).advanced).toBe(false)
    expect(advanceMock).not.toHaveBeenCalled()
  })
  it('a refusal is reported to the error dashboard and never throws', async () => {
    advanceMock.mockResolvedValue({ success: false, error: 'nope' })
    const r = await advanceNameChangeAfterOaSigned({ accountId: 'a1', oaId: 'oa1', signedOaName: 'New LLC' })
    expect(r).toEqual({ advanced: false, reason: 'nope' })
    expect(reportMock).toHaveBeenCalledTimes(1)
    advanceMock.mockRejectedValue(new Error('boom'))
    const r2 = await advanceNameChangeAfterOaSigned({ accountId: 'a1', oaId: 'oa1', signedOaName: 'New LLC' })
    expect(r2.advanced).toBe(false)
  })
})
