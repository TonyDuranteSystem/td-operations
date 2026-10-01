/**
 * N0b (dev job f907220c): the contract-text version recorded on offers and signatures.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { CURRENT_CONTRACT_VERSION, PRE_VERSIONING, contractVersionLabel } from '@/lib/offers/contract-version'
import { toPublicRenewalView } from '@/lib/offers/public-offer-view'

describe('contract version', () => {
  it('is pinned — do not bump it until N1a stores frozen contract texts', () => {
    expect(CURRENT_CONTRACT_VERSION).toBe('2026-09-30')
  })

  it('the database default stamps the same version on every new offer', () => {
    const sql = readFileSync('scripts/migrations/20260930-2330-n0b-contract-version.sql', 'utf8')
    expect(sql).toContain(`SET DEFAULT '${CURRENT_CONTRACT_VERSION}'`)
    expect(sql).toContain(`'${PRE_VERSIONING}'`)
  })

  it('labels a version for the client, and says nothing for offers signed before versions existed', () => {
    expect(contractVersionLabel('2026-09-30')).toBe('Contract version 2026-09-30')
    expect(contractVersionLabel(PRE_VERSIONING)).toBeNull()
    expect(contractVersionLabel(null)).toBeNull()
  })

  it('an unsigned renewal agreement is signed against today’s text; a signed one predates versions', () => {
    expect(toPublicRenewalView({ status: 'draft' }).contract_version).toBe(CURRENT_CONTRACT_VERSION)
    expect(toPublicRenewalView({ status: 'signed' }).contract_version).toBe(PRE_VERSIONING)
  })
})
