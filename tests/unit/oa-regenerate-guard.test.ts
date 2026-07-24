import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { hasCollectedSignatures } from '@/lib/portal/oa-regenerate-guard'

// Regression pin: re-generating an OA hard-deletes the prior agreement AND its
// oa_signatures rows. Anything that returns FALSE here gets deleted, so a false
// negative on a partially-signed MMLLC destroys executed client signatures.
describe('hasCollectedSignatures', () => {
  it('blocks a fully signed OA', () => {
    expect(hasCollectedSignatures({ status: 'signed' })).toBe(true)
  })

  it('blocks a partially signed MMLLC OA — the bug this guard exists for', () => {
    // 2 of 3 members signed: status is NOT 'signed', so the old
    // `status === 'signed'` guard let this through and deleted both signatures.
    expect(hasCollectedSignatures({ status: 'partially_signed', signed_count: 2 })).toBe(true)
  })

  it('blocks on signed_count alone when status has not caught up yet', () => {
    expect(hasCollectedSignatures({ status: 'sent', signed_count: 1 })).toBe(true)
  })

  it('allows deleting an untouched sent OA', () => {
    expect(hasCollectedSignatures({ status: 'sent', signed_count: 0 })).toBe(false)
  })

  it('allows deleting a draft and a viewed OA', () => {
    expect(hasCollectedSignatures({ status: 'draft', signed_count: 0 })).toBe(false)
    expect(hasCollectedSignatures({ status: 'viewed', signed_count: 0 })).toBe(false)
  })

  it('treats a null/absent signed_count as zero, not as a signature', () => {
    expect(hasCollectedSignatures({ status: 'sent', signed_count: null })).toBe(false)
    expect(hasCollectedSignatures({ status: 'sent' })).toBe(false)
  })

  it('does not crash on a null status', () => {
    expect(hasCollectedSignatures({ status: null })).toBe(false)
  })

  // ⛔ THE RULE EXISTING IS NOT ENOUGH — EVERY DOOR MUST CALL IT.
  //
  // The predicate below was written and unit-tested, and wired into the portal
  // route and the staff MCP tool. A THIRD door — the CRM account "Recreate"
  // button — was missed entirely and deleted a signed agreement plus every
  // signature with no status check, no soft-delete and no audit record (R100),
  // in two clicks, from the panel staff use daily. 74 executed agreements were
  // exposed. Tests that pin only the predicate cannot catch that.
  //
  // So: find EVERY file that hard-deletes from oa_agreements and require it to
  // reference the shared guard. A new fourth door fails here instead of in
  // production.
  describe('every door that deletes an agreement uses the shared guard', () => {
    it('has no unguarded oa_agreements delete anywhere in app/ or lib/', () => {
      const files = execSync(`find app lib -name "*.ts" -o -name "*.tsx"`, {
        cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      }).trim().split('\n').filter(Boolean)

      const offenders: string[] = []
      for (const f of files) {
        const src = readFileSync(join(process.cwd(), f), 'utf8')
        // A hard delete of the agreement row itself (not oa_signatures).
        const deletesAgreement = /from\(\s*["']oa_agreements["']\s*\)\s*[\s\S]{0,80}?\.delete\(\)/.test(src)
        if (!deletesAgreement) continue
        if (!src.includes('hasCollectedSignatures')) offenders.push(f)
      }

      expect(
        offenders,
        `These files hard-delete an Operating Agreement without the shared ` +
        `hasCollectedSignatures guard. A signed OA is an executed legal document — ` +
        `deleting it destroys the only proof the client signed. Guard it, or void instead.`,
      ).toEqual([])
    })
  })

  // Both doors must use this ONE predicate. The client-facing portal route was
  // guarded first; the staff MCP force_recreate path had NO status check at all
  // and would happily delete a fully signed agreement (production carries 73).
  // If someone re-introduces a bespoke check on either side, these pin the rule.
  describe('the rule both the portal button and the staff tool must share', () => {
    it('refuses every state where evidence of signing exists', () => {
      const signedStates = [
        { status: 'signed', signed_count: 1 },
        { status: 'partially_signed', signed_count: 2 },
        { status: 'sent', signed_count: 3 },
        { status: 'viewed', signed_count: 1 },
      ]
      for (const s of signedStates) {
        expect(hasCollectedSignatures(s), `expected ${JSON.stringify(s)} to be BLOCKED`).toBe(true)
      }
    })

    it('permits replacing an agreement nobody has signed — the normal supersede case', () => {
      const unsignedStates = [
        { status: 'draft', signed_count: 0 },
        { status: 'sent', signed_count: 0 },
        { status: 'viewed', signed_count: 0 },
        { status: 'voided', signed_count: 0 },
      ]
      for (const s of unsignedStates) {
        expect(hasCollectedSignatures(s), `expected ${JSON.stringify(s)} to be ALLOWED`).toBe(false)
      }
    })
  })
})
