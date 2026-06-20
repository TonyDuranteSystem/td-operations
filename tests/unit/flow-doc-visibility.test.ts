/**
 * Unit tests for isClientSafeFlowDoc (lib/flows/flow-doc-visibility.ts) — the
 * curated allowlist deciding which flow-stamped documents the client portal
 * shows. The critical case: the unsigned "Tax Return Prepared" draft must NEVER
 * be exposed unless an admin explicitly published it (portal_visible=true).
 */

import { describe, it, expect } from 'vitest'
import { isClientSafeFlowDoc } from '@/lib/flows/flow-doc-visibility'

describe('isClientSafeFlowDoc', () => {
  it('always shows a doc an admin explicitly published (portal_visible=true)', () => {
    // Even a normally-internal stage is shown once published.
    expect(isClientSafeFlowDoc('Tax Return', 'Tax Return Prepared', true)).toBe(true)
    expect(isClientSafeFlowDoc(null, null, true)).toBe(true)
  })

  it('shows client-safe Tax Return receipt/output stages', () => {
    expect(isClientSafeFlowDoc('Tax Return', 'Extension Due', false)).toBe(true)
    expect(isClientSafeFlowDoc('Tax Return', 'Filed with IRS', false)).toBe(true)
    expect(isClientSafeFlowDoc('Tax Return', 'IRS Receipt Uploaded', false)).toBe(true)
    expect(isClientSafeFlowDoc('Tax Return', 'Signed', false)).toBe(true)
  })

  it('HIDES the unsigned prepared return draft (the key privacy case)', () => {
    expect(isClientSafeFlowDoc('Tax Return', 'Tax Return Prepared', false)).toBe(false)
    expect(isClientSafeFlowDoc('Tax Return', 'Tax Return Prepared', null)).toBe(false)
  })

  it('shows AR and RA client-facing deliverables', () => {
    expect(isClientSafeFlowDoc('State Annual Report', 'Due Date', false)).toBe(true)
    expect(isClientSafeFlowDoc('State Annual Report', 'Filing Receipt Uploaded', false)).toBe(true)
    expect(isClientSafeFlowDoc('State RA Renewal', 'Renewal Due', false)).toBe(true)
    expect(isClientSafeFlowDoc('State RA Renewal', 'Document Uploaded', false)).toBe(true)
  })

  it('shows Company Formation client deliverables (Articles + EIN letter)', () => {
    // Articles of Organization are uploaded on "Filed with State" (flow_stage
    // records the pre-advance stage); the EIN letter (CP 575) on "EIN Received".
    // These are the documents the client needs (e.g. to open a bank account).
    expect(isClientSafeFlowDoc('Company Formation', 'Filed with State', false)).toBe(true)
    expect(isClientSafeFlowDoc('Company Formation', 'Articles Received', false)).toBe(true)
    expect(isClientSafeFlowDoc('Company Formation', 'EIN Received', false)).toBe(true)
  })

  it('NEVER shows the signed SS-4 to the client (internal tax doc)', () => {
    // The signed SS-4 (flow_stage="Signed") carries the responsible party's tax
    // ID and is internal-only per Antonio — it must stay staff-side even though
    // Tax Return's "Signed" stage IS client-safe (the allowlist is per service).
    expect(isClientSafeFlowDoc('Company Formation', 'Signed', false)).toBe(false)
  })

  it('HIDES internal Company Formation working stages', () => {
    // Wizard Submitted / SS-4 Prepared are internal staff stages — nothing the
    // client should see from a document stamped there unless explicitly published.
    expect(isClientSafeFlowDoc('Company Formation', 'Wizard Submitted', false)).toBe(false)
    expect(isClientSafeFlowDoc('Company Formation', 'SS-4 Prepared', false)).toBe(false)
    expect(isClientSafeFlowDoc('Company Formation', 'Payment Confirmed', false)).toBe(false)
  })

  it('fails closed for unknown service types, unknown stages, and null flow_stage', () => {
    expect(isClientSafeFlowDoc('Tax Return', 'Under Review', false)).toBe(false) // internal review stage
    expect(isClientSafeFlowDoc('Mystery Service', 'Due Date', false)).toBe(false)
    expect(isClientSafeFlowDoc('Tax Return', null, false)).toBe(false)
    expect(isClientSafeFlowDoc(null, 'Due Date', false)).toBe(false)
  })
})
