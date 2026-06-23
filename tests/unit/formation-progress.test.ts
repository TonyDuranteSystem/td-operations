import { describe, it, expect } from 'vitest'
import { buildFormationTrackerSteps, type FormationStageRow } from '@/lib/portal/formation-progress'

const STAGES: FormationStageRow[] = [
  { stage_name: 'Payment Confirmed', stage_order: 1, client_label: 'Payment confirmed', client_label_it: 'Pagamento confermato' },
  { stage_name: 'Wizard Submitted', stage_order: 2, client_label: "We're reviewing your details", client_label_it: 'Stiamo verificando i tuoi dati' },
  { stage_name: 'Filed with State', stage_order: 3, client_label: 'Filing with the state', client_label_it: 'Registrazione presso lo stato' },
  { stage_name: 'Articles Received', stage_order: 4, client_label: 'Articles received', client_label_it: 'Atto costitutivo ricevuto' },
  { stage_name: 'SS-4 Prepared', stage_order: 5, client_label: 'Sign your SS-4', client_label_it: 'Firma il modulo SS-4' },
  { stage_name: 'SS-4 Signed', stage_order: 6, client_label: 'SS-4 sent to IRS', client_label_it: "SS-4 inviato all'IRS" },
  { stage_name: 'EIN Received', stage_order: 7, client_label: 'EIN received — all set!', client_label_it: 'EIN ricevuto — tutto fatto!' },
]

describe('buildFormationTrackerSteps', () => {
  it('marks completed / current / upcoming relative to the current stage', () => {
    const steps = buildFormationTrackerSteps(STAGES, 'Filed with State', 'en')
    expect(steps.map((s) => s.status)).toEqual([
      'completed', 'completed', 'current', 'upcoming', 'upcoming', 'upcoming', 'upcoming',
    ])
  })

  it('flags the wizard step as action-required when current is Payment Confirmed', () => {
    const steps = buildFormationTrackerSteps(STAGES, 'Payment Confirmed', 'en')
    const payment = steps.find((s) => s.stageName === 'Payment Confirmed')!
    expect(payment.status).toBe('current')
    expect(payment.action).toBe('wizard')
    expect(payment.isActionRequired).toBe(true)
  })

  it('flags the signing step as action-required when current is SS-4 Prepared', () => {
    const steps = buildFormationTrackerSteps(STAGES, 'SS-4 Prepared', 'en')
    const ss4 = steps.find((s) => s.stageName === 'SS-4 Prepared')!
    expect(ss4.action).toBe('sign')
    expect(ss4.isActionRequired).toBe(true)
  })

  it('does not flag action-required for a client-action stage already passed', () => {
    const steps = buildFormationTrackerSteps(STAGES, 'Articles Received', 'en')
    const payment = steps.find((s) => s.stageName === 'Payment Confirmed')!
    expect(payment.status).toBe('completed')
    expect(payment.isActionRequired).toBe(false)
  })

  it('uses Italian labels when locale is it', () => {
    const steps = buildFormationTrackerSteps(STAGES, 'Payment Confirmed', 'it')
    expect(steps[0].label).toBe('Pagamento confermato')
  })

  it('falls back to client_label / stage_name when an Italian label is missing', () => {
    const stages: FormationStageRow[] = [
      { stage_name: 'Payment Confirmed', stage_order: 1, client_label: 'Payment confirmed', client_label_it: null },
      { stage_name: 'Wizard Submitted', stage_order: 2, client_label: null, client_label_it: null },
    ]
    const steps = buildFormationTrackerSteps(stages, 'Payment Confirmed', 'it')
    expect(steps[0].label).toBe('Payment confirmed') // client_label fallback
    expect(steps[1].label).toBe('Wizard Submitted') // stage_name fallback
  })

  it('sorts by stage_order regardless of input order', () => {
    const shuffled = [STAGES[3], STAGES[0], STAGES[6], STAGES[1]]
    const steps = buildFormationTrackerSteps(shuffled, 'Payment Confirmed', 'en')
    expect(steps.map((s) => s.stageName)).toEqual([
      'Payment Confirmed', 'Wizard Submitted', 'Articles Received', 'EIN Received',
    ])
  })

  it('marks everything upcoming when the current stage is unknown', () => {
    const steps = buildFormationTrackerSteps(STAGES, 'Nonexistent', 'en')
    expect(steps.every((s) => s.status === 'upcoming')).toBe(true)
    expect(steps.every((s) => !s.isActionRequired)).toBe(true)
  })

  describe('filedAt (filing date on the Filed-with-State step)', () => {
    const FILED_AT = '2026-06-18T15:00:00.000Z'

    it('attaches filedAt to the Filed-with-State step while AT that stage', () => {
      const steps = buildFormationTrackerSteps(STAGES, 'Filed with State', 'en', FILED_AT)
      const filed = steps.find((s) => s.stageName === 'Filed with State')!
      expect(filed.status).toBe('current')
      expect(filed.filedAt).toBe(FILED_AT)
    })

    it('keeps filedAt once the SD has advanced PAST Filed with State', () => {
      const steps = buildFormationTrackerSteps(STAGES, 'EIN Received', 'en', FILED_AT)
      const filed = steps.find((s) => s.stageName === 'Filed with State')!
      expect(filed.status).toBe('completed')
      expect(filed.filedAt).toBe(FILED_AT)
    })

    it('does NOT attach filedAt while Filed with State is still upcoming', () => {
      const steps = buildFormationTrackerSteps(STAGES, 'Payment Confirmed', 'en', FILED_AT)
      const filed = steps.find((s) => s.stageName === 'Filed with State')!
      expect(filed.status).toBe('upcoming')
      expect(filed.filedAt).toBeUndefined()
    })

    it('attaches filedAt to NO other step', () => {
      const steps = buildFormationTrackerSteps(STAGES, 'EIN Received', 'en', FILED_AT)
      const withDate = steps.filter((s) => s.filedAt)
      expect(withDate.map((s) => s.stageName)).toEqual(['Filed with State'])
    })

    it('omits filedAt entirely when no date is provided', () => {
      const steps = buildFormationTrackerSteps(STAGES, 'Filed with State', 'en')
      expect(steps.every((s) => s.filedAt == null)).toBe(true)
    })
  })
})
