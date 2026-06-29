import { describe, it, expect } from 'vitest'
import {
  validateDeliverable,
  isImageThumbnailable,
  nextConceptNumber,
  nextVersionForConcept,
  groupByConcept,
  conceptLabel,
  isDeliverableType,
  deliverableTypeLabel,
  DELIVERABLE_MAX_BYTES,
} from '@/lib/td-communication/deliverables'
import {
  nextStatusOnUpload,
  nextStatusOnReleaseFinal,
  isEnrollmentStatus,
} from '@/lib/td-communication/pipeline'
import type { CommDeliverable } from '@/lib/td-communication/types'

/** Minimal deliverable factory for grouping/numbering tests. */
function deliv(partial: Partial<CommDeliverable>): CommDeliverable {
  return {
    id: partial.id ?? 'd1',
    enrollment_id: 'e1',
    type: 'logo_draft',
    file_url: 'e1/x.png',
    drive_file_id: null,
    file_name: 'x.png',
    file_size: 10,
    mime_type: 'image/png',
    is_draft: true,
    concept_number: partial.concept_number ?? 1,
    version_number: partial.version_number ?? 1,
    watermark_applied: false,
    released_at: null,
    released_by: null,
    created_at: partial.created_at ?? '2026-06-28T00:00:00Z',
    ...partial,
  }
}

describe('validateDeliverable', () => {
  it('accepts allowed image + design extensions', () => {
    expect(validateDeliverable('logo.png', 1000)).toBeNull()
    expect(validateDeliverable('logo.svg', 1000)).toBeNull()
    expect(validateDeliverable('art.ai', 1000)).toBeNull()
    expect(validateDeliverable('layers.psd', 1000)).toBeNull()
    expect(validateDeliverable('print.eps', 1000)).toBeNull()
    expect(validateDeliverable('guide.pdf', 1000)).toBeNull()
  })

  it('blocks disallowed / executable extensions', () => {
    expect(validateDeliverable('virus.exe', 1000)).toMatch(/aren't supported/)
    expect(validateDeliverable('script.js', 1000)).toMatch(/aren't supported/)
    expect(validateDeliverable('archive.zip', 1000)).toMatch(/aren't supported/)
  })

  it('blocks files with no extension', () => {
    expect(validateDeliverable('noext', 1000)).toMatch(/no extension/)
  })

  it('blocks oversize files', () => {
    expect(validateDeliverable('big.png', DELIVERABLE_MAX_BYTES + 1)).toMatch(/too large/)
  })

  it('is case-insensitive on extension', () => {
    expect(validateDeliverable('LOGO.PNG', 1000)).toBeNull()
  })
})

describe('isImageThumbnailable', () => {
  it('true for raster + svg image extensions', () => {
    expect(isImageThumbnailable('a.png')).toBe(true)
    expect(isImageThumbnailable('a.jpg')).toBe(true)
    expect(isImageThumbnailable('a.svg')).toBe(true)
  })
  it('false for non-image design/doc files', () => {
    expect(isImageThumbnailable('a.pdf')).toBe(false)
    expect(isImageThumbnailable('a.ai')).toBe(false)
    expect(isImageThumbnailable('a.psd')).toBe(false)
  })
  it('falls back to the mime type when there is no extension', () => {
    expect(isImageThumbnailable('blob', 'image/png')).toBe(true)
    expect(isImageThumbnailable('blob', 'application/pdf')).toBe(false)
  })
})

describe('nextConceptNumber', () => {
  it('returns 1 when empty', () => {
    expect(nextConceptNumber([])).toBe(1)
  })
  it('returns max + 1', () => {
    expect(nextConceptNumber([{ concept_number: 1 }, { concept_number: 3 }])).toBe(4)
  })
})

describe('nextVersionForConcept', () => {
  it('returns 1 for a fresh concept', () => {
    expect(nextVersionForConcept([], 1)).toBe(1)
    expect(nextVersionForConcept([{ concept_number: 2, version_number: 5 }], 1)).toBe(1)
  })
  it('returns max + 1 within the concept only', () => {
    const rows = [
      { concept_number: 1, version_number: 1 },
      { concept_number: 1, version_number: 2 },
      { concept_number: 2, version_number: 9 },
    ]
    expect(nextVersionForConcept(rows, 1)).toBe(3)
    expect(nextVersionForConcept(rows, 2)).toBe(10)
  })
})

describe('groupByConcept', () => {
  it('groups by concept ascending and sorts versions newest-first', () => {
    const out = groupByConcept([
      deliv({ id: 'a', concept_number: 1, version_number: 1 }),
      deliv({ id: 'b', concept_number: 1, version_number: 2 }),
      deliv({ id: 'c', concept_number: 2, version_number: 1 }),
    ])
    expect(out.map((g) => g.concept)).toEqual([1, 2])
    expect(out[0].versions.map((v) => v.id)).toEqual(['b', 'a']) // v2 before v1
    expect(out[1].versions.map((v) => v.id)).toEqual(['c'])
  })
})

describe('conceptLabel', () => {
  it('maps 1..26 to letters', () => {
    expect(conceptLabel(1)).toBe('Concept A')
    expect(conceptLabel(3)).toBe('Concept C')
  })
  it('falls back to the number beyond Z', () => {
    expect(conceptLabel(27)).toBe('Concept 27')
  })
})

describe('deliverable type helpers', () => {
  it('isDeliverableType validates known values', () => {
    expect(isDeliverableType('logo_final')).toBe(true)
    expect(isDeliverableType('nope')).toBe(false)
  })
  it('deliverableTypeLabel returns a friendly label', () => {
    expect(deliverableTypeLabel('landing_page')).toBe('Landing Page')
    expect(deliverableTypeLabel('mystery')).toBe('Other')
  })
})

describe('status transition helpers', () => {
  it('nextStatusOnUpload nudges from pre-review states (incl. revision)', () => {
    expect(nextStatusOnUpload('enrolled')).toBe('concept_ready')
    expect(nextStatusOnUpload('form_submitted')).toBe('concept_ready')
    expect(nextStatusOnUpload('in_progress')).toBe('concept_ready')
    expect(nextStatusOnUpload('revision')).toBe('concept_ready')
  })
  it('nextStatusOnUpload leaves later states unchanged', () => {
    expect(nextStatusOnUpload('concept_ready')).toBeNull()
    expect(nextStatusOnUpload('approved')).toBeNull()
    expect(nextStatusOnUpload('delivered')).toBeNull()
    expect(nextStatusOnUpload('cancelled')).toBeNull()
  })
  it('nextStatusOnReleaseFinal delivers unless cancelled/delivered', () => {
    expect(nextStatusOnReleaseFinal('concept_ready')).toBe('delivered')
    expect(nextStatusOnReleaseFinal('approved')).toBe('delivered')
    expect(nextStatusOnReleaseFinal('delivered')).toBeNull()
    expect(nextStatusOnReleaseFinal('cancelled')).toBeNull()
  })
  it('isEnrollmentStatus validates the known set', () => {
    expect(isEnrollmentStatus('delivered')).toBe(true)
    expect(isEnrollmentStatus('full')).toBe(false)
  })
})
