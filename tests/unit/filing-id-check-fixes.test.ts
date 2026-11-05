/**
 * State Filing ID check — the fixes from the bug hunt on the live feature (job 64d2be64, 2026-11-04):
 *   - crafted upload paths ("../") are never trusted, signed or read
 *   - a Filing ID that is really a tax number (EIN / SSN / ITIN) is flagged
 *   - the record line for a Confirm says honestly what was (not) checked
 *   - the standard review path tidies what the client typed instead of saving "N/A"
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTraversalSafePath, isDirectReadSafePath } from '@/lib/storage/safe-path'
import { ownedUploadPaths } from '@/lib/flows/onboarding-articles'
import { collectUploadPaths } from '@/lib/portal/wizard-uploads'
import { looksLikeTaxId } from '@/lib/flows/filing-id-check'
import { filingIdConfirmLine } from '@/lib/operations/onboarding-review'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

describe('isTraversalSafePath', () => {
  it('accepts every real upload shape', () => {
    for (const p of [
      'onboarding/lead-1/articles_of_organization_ab12_Articles of Organization - X LLC.pdf',
      'formation/offer-9/passport_owner_1_Passport.pdf',
      'tok-1/articles_of_organization_IAA.pdf',
      'onboarding/acct-1/file..name.pdf', // dots inside a NAME are fine; only a whole ".." segment walks out
    ]) expect(isTraversalSafePath(p)).toBe(true)
  })

  it('refuses a path that can walk out of its folder', () => {
    for (const p of [
      'onboarding/lead-1/../../x/articles_of_organization.pdf',
      '../onboarding/lead-1/a.pdf',
      'onboarding/lead-1/./a.pdf',
      'onboarding//lead-1/a.pdf',
      '/onboarding/lead-1/a.pdf',
      'onboarding/lead-1/',
      'onboarding\\lead-1\\a.pdf',
      'onboarding/lead-1/a\u0000.pdf',
      'onboarding/lead-1/a\n.pdf',
    ]) expect(isTraversalSafePath(p)).toBe(false)
  })

  it('refuses anything that is not a non-empty string', () => {
    for (const p of [null, undefined, '', 42, { a: 1 }, ['a']]) expect(isTraversalSafePath(p)).toBe(false)
  })
})

describe('isDirectReadSafePath', () => {
  it('a name with ? # or % can still be shown (signed) but not read by path', () => {
    expect(isDirectReadSafePath('onboarding/lead-1/articles_of_organization_a_Articles.pdf')).toBe(true)
    for (const p of ['onboarding/lead-1/a #2.pdf', 'onboarding/lead-1/a?x=1.pdf', 'onboarding/lead-1/a%2e%2e.pdf']) {
      expect(isTraversalSafePath(p)).toBe(true)
      expect(isDirectReadSafePath(p)).toBe(false)
    }
  })
})

describe('ownedUploadPaths — crafted paths', () => {
  const sub = { token: 'tok-1', account_id: null, lead_id: 'lead-1', offer_id: null, contact_id: null }
  it('a path under the submission\'s own prefix that walks out of it is not owned', () => {
    const good = 'onboarding/lead-1/articles_of_organization_a_File.pdf'
    const bad = [
      'onboarding/lead-1/../../../rest/v1/x?q=/articles_of_organization.pdf',
      'onboarding/lead-1/../lead-2/articles_of_organization_a_File.pdf',
      'tok-1/../tok-2/articles_of_organization_a_File.pdf',
    ]
    const { owned, rejected } = ownedUploadPaths(sub, [good, ...bad])
    expect(owned).toEqual([good])
    expect(rejected).toBe(3)
  })
})

describe('collectUploadPaths — crafted paths', () => {
  it('keeps real wizard uploads and drops a path that walks out of its folder, whatever its prefix', () => {
    const data = {
      articles_of_organization: ['onboarding/lead-1/articles_of_organization_a_File.pdf', 'onboarding/lead-1/../../x/articles_of_organization_b.pdf'],
      passport: 'onboarding/lead-1/passport_owner_1_P.pdf',
      other: 'onboarding/lead-1\\..\\p.pdf',
    }
    expect(collectUploadPaths(data)).toEqual(['onboarding/lead-1/articles_of_organization_a_File.pdf', 'onboarding/lead-1/passport_owner_1_P.pdf'])
  })
})

describe('looksLikeTaxId', () => {
  it('flags an EIN, an SSN / ITIN, and the very EIN the client gave', () => {
    expect(looksLikeTaxId('12-3456789')).toBe(true)
    expect(looksLikeTaxId(' 12 - 3456789 ')).toBe(true)
    expect(looksLikeTaxId('123-45-6789')).toBe(true)
    expect(looksLikeTaxId('923456789', '92-3456789')).toBe(true)
    expect(looksLikeTaxId('92-3456789', '923456789')).toBe(true)
  })

  it('never flags the Filing ID shapes of the states we serve', () => {
    for (const v of ['2026-002103965', '2025-001586941', 'L24000123456', '3190157', '7654321', '2019-000812345']) {
      expect(looksLikeTaxId(v)).toBe(false)
      expect(looksLikeTaxId(v, '92-3456789')).toBe(false)
    }
  })

  it('an unusable or empty box, or an unknown / short EIN, flags nothing', () => {
    expect(looksLikeTaxId('')).toBe(false)
    expect(looksLikeTaxId('N/A')).toBe(false)
    expect(looksLikeTaxId('923456789', null)).toBe(false)
    expect(looksLikeTaxId('923456789', '12345')).toBe(false)
  })
})

describe('filingIdConfirmLine', () => {
  const submitted = { filing_id: '2026-001234567' }
  it('says nobody checked, and what the client typed, when the Confirm carried no call', () => {
    const line = filingIdConfirmLine({ value: null, unchecked: true }, 'luca@tonydurante.us', submitted)
    expect(line).toMatch(/No State Filing ID was checked on this Confirm, so none is saved/)
    expect(line).toContain('the client typed "2026-001234567"')
  })

  it('leaves the client\'s text out when nothing was typed, and cuts a very long one', () => {
    expect(filingIdConfirmLine({ value: null, unchecked: true }, 'a', {})).not.toMatch(/client typed/)
    expect(filingIdConfirmLine({ value: null, unchecked: true }, 'a', { filing_id: 'x'.repeat(200) }).length).toBeLessThan(220)
  })

  it('claims "checked on the Articles" only when there was a document to check against', () => {
    expect(filingIdConfirmLine({ value: '2026-002103965' }, 'luca@tonydurante.us', submitted)).toMatch(/checked on the Articles by luca@tonydurante.us: 2026-002103965/)
    expect(filingIdConfirmLine({ value: '2026-002103965', documentChecked: true }, 'luca@tonydurante.us', submitted)).toMatch(/checked on the Articles/)
    const noDoc = filingIdConfirmLine({ value: '2026-002103965', documentChecked: false }, 'luca@tonydurante.us', submitted)
    expect(noDoc).toMatch(/confirmed by luca@tonydurante.us — no uploaded Articles could be opened/)
    expect(noDoc).not.toMatch(/checked on the Articles/)
  })

  it('"none on the document" keeps its own line', () => {
    expect(filingIdConfirmLine({ value: null }, 'luca@tonydurante.us', submitted)).toMatch(/No Filing ID will be saved from this Confirm/)
  })
})

describe('wiring — what the live code must still do', () => {
  it('the standard review path tidies the client\'s number (no "N/A" / spaces on a company) and says it was not checked', () => {
    const ops = read('lib/operations/onboarding-review.ts')
    const applyFn = ops.slice(ops.indexOf('export async function applyOnboardingReview'), ops.indexOf('export async function confirmPortalWizardOnboarding'))
    expect(applyFn).toContain('filingId ? filingId.value : normalizeFilingId(submitted.filing_id)')
    expect(applyFn).not.toContain('String(submitted.filing_id)')
    expect(applyFn).toContain('NOT checked against the Articles')
  })

  it('the review screen hands the client\'s EIN to the card, and the card shows the tax-number warning', () => {
    expect(read('app/(dashboard)/onboarding-review/components/onboarding-review-list.tsx')).toContain('einHint={')
    expect(read('app/(dashboard)/onboarding-review/components/onboarding-filing-id-check.tsx')).toContain('einHint={einHint}')
    const card = read('components/flows/filing-id-check-card.tsx')
    expect(card).toContain('looksLikeTaxId(typed, einHint)')
    expect(card).toContain('data-testid="filing-id-looks-like-tax-id"')
  })

  it('the review screen tells staff when some uploaded Articles could not be matched', () => {
    expect(read('app/(dashboard)/onboarding-review/components/onboarding-filing-id-check.tsx')).toContain('data-testid="filing-id-unmatched-articles"')
  })

  it('the upload-path collector and the ownership filter both use the traversal check', () => {
    expect(read('lib/portal/wizard-uploads.ts')).toContain('isTraversalSafePath(s)')
    expect(read('lib/flows/onboarding-articles.ts')).toContain('isTraversalSafePath(p)')
    expect(read('app/api/onboarding-review/[id]/articles-check/route.ts')).toContain('isDirectReadSafePath(doc.path)')
  })
})
