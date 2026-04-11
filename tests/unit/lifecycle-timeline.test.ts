import { describe, it, expect } from 'vitest'
import { assembleTimeline, type TimelineInput } from '@/lib/lifecycle-timeline'

describe('assembleTimeline', () => {
  it('returns empty array for empty input', () => {
    expect(assembleTimeline({})).toEqual([])
  })

  it('creates lead_created event', () => {
    const events = assembleTimeline({
      lead: { created_at: '2026-04-10T10:00:00Z', status: 'New' },
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('lead_created')
    expect(events[0].color).toBe('gray')
    expect(events[0].title).toBe('Lead created')
  })

  it('creates lead_converted event when converted_to_contact_id exists', () => {
    const events = assembleTimeline({
      lead: { created_at: '2026-04-10T10:00:00Z', converted_to_contact_id: 'abc', updated_at: '2026-04-15T12:00:00Z' },
    })
    expect(events).toHaveLength(2)
    expect(events[1].type).toBe('lead_converted')
    expect(events[1].color).toBe('green')
  })

  it('creates call_completed from callSummary', () => {
    const events = assembleTimeline({
      callSummary: { created_at: '2026-04-10T11:00:00Z', meeting_name: 'Test Call', duration_seconds: 2520 },
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('call_completed')
    expect(events[0].detail).toBe('Test Call — 42 min')
  })

  it('falls back to lead.call_date when no callSummary', () => {
    const events = assembleTimeline({
      lead: { created_at: '2026-04-09T10:00:00Z', call_date: '2026-04-10' },
    })
    expect(events).toHaveLength(2)
    expect(events.find(e => e.type === 'call_completed')).toBeTruthy()
  })

  it('creates offer events with version label', () => {
    const events = assembleTimeline({
      offers: [
        { token: 'test-v2', status: 'draft', created_at: '2026-04-12T10:00:00Z', viewed_at: '2026-04-13T08:00:00Z', version: 2, superseded_by: null },
        { token: 'test', status: 'superseded', created_at: '2026-04-11T10:00:00Z', viewed_at: null, version: 1, superseded_by: 'test-v2' },
      ],
    })
    const created = events.filter(e => e.type === 'offer_created')
    expect(created).toHaveLength(2)
    expect(created.find(e => e.title === 'Offer v2 created')).toBeTruthy()
    expect(created.find(e => e.title === 'Offer created')).toBeTruthy()
    expect(events.find(e => e.type === 'offer_viewed')?.title).toBe('Offer v2 viewed by client')
    expect(events.find(e => e.type === 'offer_superseded')).toBeTruthy()
  })

  it('creates email events', () => {
    const events = assembleTimeline({
      emailTracking: [
        { id: 'e1', subject: 'Your Offer', created_at: '2026-04-12T14:00:00Z', first_opened_at: '2026-04-13T09:00:00Z' },
      ],
    })
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('email_sent')
    expect(events[0].detail).toBe('Your Offer')
    expect(events[1].type).toBe('email_opened')
  })

  it('creates contract_signed event', () => {
    const events = assembleTimeline({
      contracts: [{ offer_token: 'test', signed_at: '2026-04-14T16:00:00Z' }],
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('contract_signed')
    expect(events[0].color).toBe('green')
  })

  it('skips contract without signed_at', () => {
    const events = assembleTimeline({
      contracts: [{ offer_token: 'test', signed_at: null }],
    })
    expect(events).toHaveLength(0)
  })

  it('creates activation and payment_confirmed events', () => {
    const events = assembleTimeline({
      activations: [{
        id: 'a1', status: 'payment_confirmed', created_at: '2026-04-14T16:30:00Z',
        payment_confirmed_at: '2026-04-15T10:00:00Z', amount: 2500, currency: 'EUR',
      }],
    })
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('activation_created')
    expect(events[1].type).toBe('payment_confirmed')
    expect(events[1].detail).toContain('€')
    expect(events[1].detail).toContain('2,500')
  })

  it('creates wizard events', () => {
    const events = assembleTimeline({
      wizardProgress: [{
        id: 'w1', current_step: 3, status: 'in_progress',
        created_at: '2026-04-16T10:00:00Z', updated_at: '2026-04-17T14:00:00Z',
      }],
    })
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('wizard_started')
    expect(events[1].type).toBe('wizard_progress')
    expect(events[1].title).toBe('Wizard reached step 3')
  })

  it('creates wizard_completed event', () => {
    const events = assembleTimeline({
      wizardProgress: [{
        id: 'w1', current_step: 5, status: 'completed',
        created_at: '2026-04-16T10:00:00Z', updated_at: '2026-04-18T12:00:00Z',
        completed_at: '2026-04-18T12:00:00Z',
      }],
    })
    const completed = events.find(e => e.type === 'wizard_completed')
    expect(completed).toBeTruthy()
    expect(completed?.color).toBe('green')
  })

  it('creates sd_created events', () => {
    const events = assembleTimeline({
      serviceDeliveries: [
        { id: 'sd1', service_type: 'formation', service_name: 'Company Formation', status: 'active', created_at: '2026-04-19T10:00:00Z' },
      ],
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('sd_created')
    expect(events[0].title).toBe('Service: Company Formation')
    expect(events[0].color).toBe('indigo')
  })

  it('creates payment_recorded events for paid invoices only', () => {
    const events = assembleTimeline({
      payments: [
        { id: 'p1', description: 'Setup fee', amount: 2500, status: 'Paid', created_at: '2026-04-15T10:00:00Z' },
        { id: 'p2', description: 'Pending', amount: 1000, status: 'Unpaid', created_at: '2026-04-16T10:00:00Z' },
      ],
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('payment_recorded')
  })

  it('sorts all events chronologically', () => {
    const input: TimelineInput = {
      lead: { created_at: '2026-04-10T10:00:00Z' },
      offers: [{ token: 'test', status: 'draft', created_at: '2026-04-11T10:00:00Z' }],
      contracts: [{ offer_token: 'test', signed_at: '2026-04-14T16:00:00Z' }],
      callSummary: { created_at: '2026-04-10T11:00:00Z' },
    }
    const events = assembleTimeline(input)
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].date).getTime()).toBeGreaterThanOrEqual(new Date(events[i - 1].date).getTime())
    }
  })

  it('handles full lifecycle end-to-end', () => {
    const events = assembleTimeline({
      lead: { created_at: '2026-04-10T10:00:00Z', status: 'Converted', converted_to_contact_id: 'c1', updated_at: '2026-04-20T10:00:00Z' },
      callSummary: { created_at: '2026-04-10T11:00:00Z', duration_seconds: 1800 },
      offers: [
        { token: 'test', status: 'superseded', created_at: '2026-04-11T10:00:00Z', viewed_at: '2026-04-12T08:00:00Z', version: 1, superseded_by: 'test-v2' },
        { token: 'test-v2', status: 'signed', created_at: '2026-04-13T10:00:00Z', viewed_at: '2026-04-14T08:00:00Z', version: 2 },
      ],
      contracts: [{ offer_token: 'test-v2', signed_at: '2026-04-15T16:00:00Z' }],
      activations: [{ id: 'a1', status: 'activated', created_at: '2026-04-15T16:30:00Z', payment_confirmed_at: '2026-04-16T10:00:00Z', amount: 2500, currency: 'EUR' }],
      wizardProgress: [{ id: 'w1', current_step: 5, status: 'completed', created_at: '2026-04-17T10:00:00Z', updated_at: '2026-04-19T12:00:00Z', completed_at: '2026-04-19T12:00:00Z' }],
      serviceDeliveries: [{ id: 'sd1', service_type: 'formation', service_name: 'Company Formation', status: 'active', created_at: '2026-04-18T10:00:00Z' }],
    })
    // Should have many events, all sorted chronologically
    expect(events.length).toBeGreaterThanOrEqual(10)
    for (let i = 1; i < events.length; i++) {
      expect(new Date(events[i].date).getTime()).toBeGreaterThanOrEqual(new Date(events[i - 1].date).getTime())
    }
    // First should be lead_created, last should be lead_converted
    expect(events[0].type).toBe('lead_created')
    expect(events[events.length - 1].type).toBe('lead_converted')
  })
})
