/** Dev job e3215801 — a workspace upload box can carry its DEFAULT Storage type in the stage layout (`documentType`); absent = no picker, as before. */
import { describe, it, expect } from 'vitest'
import { parseStageLayout } from '@/lib/flows/stage-layout'

describe('stage layout: documentType on a document_upload box', () => {
  it('is read from the layout', () => {
    const l = parseStageLayout({ components: [{ type: 'document_upload', label: 'Upload CP565 ITIN Letter', documentType: 'itin_letter' }] })
    expect(l?.components[0].documentType).toBe('itin_letter')
  })
  it('absent, empty or not a string -> undefined (the box has no picker and behaves as before)', () => {
    for (const documentType of [undefined, '', 5, null, {}]) {
      const l = parseStageLayout({ components: [{ type: 'document_upload', label: 'Upload', documentType }] })
      expect(l?.components[0].documentType).toBeUndefined()
    }
  })
  it('the other box fields are untouched', () => {
    const c = parseStageLayout({ components: [{ type: 'document_upload', label: 'x', autoAdvance: false, folder: '1. Company', rename: 'EIN {company_name}', documentType: 'receipt' }] })?.components[0]
    expect(c).toMatchObject({ autoAdvance: false, folder: '1. Company', rename: 'EIN {company_name}', documentType: 'receipt' })
  })
})
