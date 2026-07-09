/**
 * Security invariant: the combined "SS-4 + Articles (IRS Package)" workspace
 * document must NEVER be visible to the client. It carries the SS-4 (the
 * responsible party's tax ID) and exists only for staff to fax the IRS.
 *
 * Two independent gates protect it, and this test pins both:
 *  1. It is written portal_visible=false → excluded from the account
 *     "Company documents" portal query (which requires portal_visible=true).
 *  2. It is a flow-stamped doc with NO flow_stage (autoSaveDocument never sets
 *     one) → the curated flow-doc allowlist (isClientSafeFlowDoc) fails closed.
 *
 * Contrast: the STANDALONE Articles (flow_stage "Filed with State") IS
 * client-safe — so the client keeps their standalone Articles while the merged
 * IRS package stays internal.
 */

import { describe, it, expect } from 'vitest'
import { isClientSafeFlowDoc } from '@/lib/flows/flow-doc-visibility'

describe('SS-4 + Articles IRS package — client visibility', () => {
  it('is NOT client-safe: no flow_stage + portal_visible=false → hidden', () => {
    // The package row as autoSaveDocument writes it: portal_visible=false, and
    // flow_stage is null (autoSaveDocument has no flow_stage param).
    expect(isClientSafeFlowDoc('Company Formation', null, false)).toBe(false)
    expect(isClientSafeFlowDoc('Company Formation', undefined, false)).toBe(false)
  })

  it('stays hidden even if an unrelated non-client-safe stage were ever stamped', () => {
    expect(isClientSafeFlowDoc('Company Formation', 'SS-4 Signed', false)).toBe(false)
    expect(isClientSafeFlowDoc('Company Formation', 'SS-4 Prepared', false)).toBe(false)
  })

  it('contrast: the standalone Articles ("Filed with State") IS client-safe', () => {
    expect(isClientSafeFlowDoc('Company Formation', 'Filed with State', false)).toBe(true)
    expect(isClientSafeFlowDoc('Company Formation', 'EIN Received', false)).toBe(true)
  })
})
