import { describe, it, expect } from 'vitest'
import {
  PIPELINE_COLUMNS,
  statusToColumn,
  daysRemaining,
  slaIndicator,
  deadlineLabel,
  packageLabel,
  subjectTypeLabel,
  groupBrief,
  nextStatusOnRelease,
} from '@/lib/td-communication/pipeline'
import {
  pickSubjectRef,
  buildSubject,
  type SubjectNameMaps,
} from '@/lib/td-communication/subject'

/* --------------------------- nextStatusOnRelease -------------------------- */

describe('nextStatusOnRelease', () => {
  it('nudges pre-review statuses to concept_ready', () => {
    expect(nextStatusOnRelease('enrolled')).toBe('concept_ready')
    expect(nextStatusOnRelease('form_submitted')).toBe('concept_ready')
    expect(nextStatusOnRelease('in_progress')).toBe('concept_ready')
    expect(nextStatusOnRelease('revision')).toBe('concept_ready')
  })

  it('never downgrades concept_ready/approved/delivered/cancelled', () => {
    expect(nextStatusOnRelease('concept_ready')).toBeNull()
    expect(nextStatusOnRelease('approved')).toBeNull()
    expect(nextStatusOnRelease('delivered')).toBeNull()
    expect(nextStatusOnRelease('cancelled')).toBeNull()
  })

  it('returns null for an unknown status', () => {
    expect(nextStatusOnRelease('bogus')).toBeNull()
  })
})

/* ------------------------------ columns ---------------------------------- */

describe('statusToColumn', () => {
  it('maps all 8 statuses to the right column (cancelled hidden)', () => {
    expect(statusToColumn('enrolled')).toBe('new')
    expect(statusToColumn('form_submitted')).toBe('new')
    expect(statusToColumn('in_progress')).toBe('in_progress')
    expect(statusToColumn('concept_ready')).toBe('review')
    expect(statusToColumn('revision')).toBe('revision')
    expect(statusToColumn('approved')).toBe('approved')
    expect(statusToColumn('delivered')).toBe('delivered')
    expect(statusToColumn('cancelled')).toBeNull()
  })

  it('returns null for an unknown status', () => {
    expect(statusToColumn('bogus')).toBeNull()
    expect(statusToColumn('')).toBeNull()
  })

  it('every non-null mapped column exists in PIPELINE_COLUMNS', () => {
    const keys = new Set(PIPELINE_COLUMNS.map((c) => c.key))
    for (const s of ['enrolled', 'form_submitted', 'in_progress', 'concept_ready', 'revision', 'approved', 'delivered']) {
      const col = statusToColumn(s)
      expect(col).not.toBeNull()
      expect(keys.has(col!)).toBe(true)
    }
  })
})

/* ------------------------------ SLA -------------------------------------- */

describe('daysRemaining / slaIndicator / deadlineLabel', () => {
  const now = new Date('2026-06-28T12:00:00Z')

  it('handles null / invalid deadlines', () => {
    expect(daysRemaining(null, now)).toBeNull()
    expect(daysRemaining(undefined, now)).toBeNull()
    expect(daysRemaining('not-a-date', now)).toBeNull()
    expect(slaIndicator(null, now)).toBeNull()
    expect(deadlineLabel(null, now)).toBeNull()
  })

  it('computes calendar-day deltas regardless of time of day', () => {
    expect(daysRemaining('2026-06-28T23:59:00Z', now)).toBe(0) // today
    expect(daysRemaining('2026-06-29T01:00:00Z', now)).toBe(1) // tomorrow
    expect(daysRemaining('2026-07-03T00:00:00Z', now)).toBe(5)
    expect(daysRemaining('2026-06-26T00:00:00Z', now)).toBe(-2) // overdue
  })

  it('colors the dot: overdue red, today/tomorrow yellow, else green', () => {
    expect(slaIndicator('2026-06-26', now)).toBe('red')
    expect(slaIndicator('2026-06-28', now)).toBe('yellow') // today
    expect(slaIndicator('2026-06-29', now)).toBe('yellow') // tomorrow
    expect(slaIndicator('2026-06-30', now)).toBe('green')
    expect(slaIndicator('2026-07-10', now)).toBe('green')
  })

  it('labels the countdown', () => {
    expect(deadlineLabel('2026-06-26', now)).toBe('Overdue by 2 days')
    expect(deadlineLabel('2026-06-27', now)).toBe('Overdue by 1 day')
    expect(deadlineLabel('2026-06-28', now)).toBe('Due today')
    expect(deadlineLabel('2026-06-29', now)).toBe('Due tomorrow')
    expect(deadlineLabel('2026-07-03', now)).toBe('Due in 5 days')
  })
})

/* ------------------------------ labels ----------------------------------- */

describe('packageLabel', () => {
  it('uses the static map when known', () => {
    expect(packageLabel('logo-landing')).toBe('Logo + Landing Page')
    expect(packageLabel('full-brand')).toBe('Full Brand Package')
  })
  it('title-cases an unknown slug', () => {
    expect(packageLabel('custom-mascot-design')).toBe('Custom Mascot Design')
    expect(packageLabel('social_kit_pro')).toBe('Social Kit Pro')
  })
  it('falls back for empty / null', () => {
    expect(packageLabel(null)).toBe('Custom Project')
    expect(packageLabel('')).toBe('Custom Project')
    expect(packageLabel('   ')).toBe('Custom Project')
  })
})

describe('subjectTypeLabel', () => {
  it('maps each actor type', () => {
    expect(subjectTypeLabel('account')).toBe('Company')
    expect(subjectTypeLabel('contact')).toBe('Individual')
    expect(subjectTypeLabel('lead')).toBe('Lead')
    expect(subjectTypeLabel('partner')).toBe('Partner')
    expect(subjectTypeLabel('weird')).toBe('Client')
  })
})

/* ------------------------------ brief ------------------------------------ */

describe('groupBrief', () => {
  it('groups a full 4-step brand audit into ordered sections + uploads', () => {
    const brief = groupBrief({
      // Step 1 — Business & Strategy
      business_description: 'We sell rockets',
      core_values: ['bold', 'honest'],
      competitors: 'SpaceY',
      // Step 2 — Brand Personality
      company_personality: 'Adventurous',
      // Step 3 — Visual & Design
      brand_name: 'Acme',
      color_personality: 'blue',
      geometric_shapes: 'rounded',
      // Step 4 — Final Details
      one_word: 'Bold',
      additional_notes: 'Rush it',
      disclaimer_accepted: true,
      // uploads via the field's own key (not a combined `uploads` blob)
      upload_materials: [
        { name: 'logo.png', url: 'onboarding-uploads/logo.png', mime_type: 'image/png' },
        'onboarding-uploads/brief.pdf',
      ],
    })
    const titles = brief.sections.map((s) => s.title)
    expect(titles).toEqual([
      'Business & Strategy',
      'Brand Personality',
      'Visual & Design',
      'Final Details',
    ])
    // array values join
    expect(brief.sections[0].fields.find((f) => f.label === 'Core Values')?.value).toBe('bold, honest')
    expect(brief.sections[2].fields.find((f) => f.label === 'Brand Name')?.value).toBe('Acme')
    expect(brief.sections[3].fields.find((f) => f.label === 'Accuracy Confirmed')?.value).toBe('Yes')
    // uploads read from the file key, both string + object shapes normalized
    expect(brief.uploads).toHaveLength(2)
    expect(brief.uploads[1]).toEqual({ name: 'brief.pdf', url: 'onboarding-uploads/brief.pdf' })
  })

  it('reads uploads from legacy file keys (materials / current_materials)', () => {
    const brief = groupBrief({
      materials: 'onboarding-uploads/old-logo.svg',
      current_materials: ['onboarding-uploads/guidelines.pdf'],
    })
    expect(brief.uploads.map((u) => u.name)).toEqual(['old-logo.svg', 'guidelines.pdf'])
  })

  it('drops empty sections and empty fields, keeps unknown keys in Other Details', () => {
    const brief = groupBrief({
      business_description: 'Just this',
      mission: '   ', // whitespace → dropped
      favorite_animal: 'otter', // unknown → Other Details
      extra: null, // dropped
    })
    const titles = brief.sections.map((s) => s.title)
    expect(titles).toEqual(['Business & Strategy', 'Other Details'])
    expect(brief.sections[0].fields).toEqual([{ label: 'Business Description', value: 'Just this' }])
    expect(brief.sections[1].fields).toEqual([{ label: 'Favorite Animal', value: 'otter' }])
    expect(brief.uploads).toEqual([])
  })

  it('does not dump file keys into Other Details', () => {
    const brief = groupBrief({ upload_materials: ['onboarding-uploads/x.png'] })
    expect(brief.sections).toEqual([]) // the only key is a file key → no text section
    expect(brief.uploads).toHaveLength(1)
  })

  it('handles empty / null / non-object input', () => {
    expect(groupBrief({})).toEqual({ sections: [], uploads: [] })
    expect(groupBrief(null)).toEqual({ sections: [], uploads: [] })
    expect(groupBrief(undefined)).toEqual({ sections: [], uploads: [] })
  })
})

/* ------------------------------ subject ---------------------------------- */

describe('pickSubjectRef', () => {
  it('follows precedence account > contact > lead > partner', () => {
    expect(pickSubjectRef({ account_id: 'a', contact_id: 'c', lead_id: 'l', partner_id: 'p' })).toEqual({ type: 'account', id: 'a' })
    expect(pickSubjectRef({ account_id: null, contact_id: 'c', lead_id: 'l', partner_id: 'p' })).toEqual({ type: 'contact', id: 'c' })
    expect(pickSubjectRef({ account_id: null, contact_id: null, lead_id: 'l', partner_id: 'p' })).toEqual({ type: 'lead', id: 'l' })
    expect(pickSubjectRef({ account_id: null, contact_id: null, lead_id: null, partner_id: 'p' })).toEqual({ type: 'partner', id: 'p' })
  })
  it('returns null when no subject is set', () => {
    expect(pickSubjectRef({ account_id: null, contact_id: null, lead_id: null, partner_id: null })).toBeNull()
  })
})

describe('buildSubject', () => {
  const maps: SubjectNameMaps = {
    account: new Map([['a', { name: 'Acme LLC', email: null }]]),
    contact: new Map([['c', { name: 'Jane Doe', email: 'jane@x.com' }]]),
    lead: new Map(),
    partner: new Map(),
  }
  it('resolves a hit with name + email', () => {
    expect(buildSubject({ type: 'contact', id: 'c' }, maps)).toEqual({ type: 'contact', id: 'c', name: 'Jane Doe', email: 'jane@x.com' })
  })
  it('falls back to "Client" on a miss (deleted subject)', () => {
    expect(buildSubject({ type: 'lead', id: 'gone' }, maps)).toEqual({ type: 'lead', id: 'gone', name: 'Client', email: null })
  })
  it('returns a safe default for a null ref', () => {
    expect(buildSubject(null, maps)).toEqual({ type: 'account', id: '', name: 'Client', email: null })
  })
})
