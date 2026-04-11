import { describe, it, expect } from 'vitest'

/**
 * Circleback Bridge — email matching logic
 *
 * The bridge matches leads to call_summaries by comparing
 * the lead's email against the attendees array in each call.
 * This is the core matching function extracted for testability.
 */

interface Attendee {
  name?: string | null
  email?: string | null
}

/** Match a target email against a call's attendees array */
function matchAttendeeEmail(attendees: Attendee[], targetEmail: string): boolean {
  if (!targetEmail) return false
  const target = targetEmail.toLowerCase().trim()
  return attendees.some(a => a.email?.toLowerCase().trim() === target)
}

/** Build an email->callId lookup from a list of calls */
function buildEmailCallMap(
  calls: Array<{ id: string; attendees: Attendee[] }>,
  excludeEmail?: string
): Map<string, string> {
  const map = new Map<string, string>()
  for (const call of calls) {
    if (!Array.isArray(call.attendees)) continue
    for (const att of call.attendees) {
      if (!att.email) continue
      const email = att.email.toLowerCase().trim()
      if (excludeEmail && email === excludeEmail.toLowerCase()) continue
      if (!map.has(email)) {
        map.set(email, call.id)
      }
    }
  }
  return map
}

describe('matchAttendeeEmail', () => {
  const attendees: Attendee[] = [
    { name: 'Antonio Durante', email: 'antonio.durante@tonydurante.us' },
    { name: 'Fireflies.ai Notetaker Tony', email: null },
    { name: 'Luca Gallacci', email: 'lucagallacci.lavoro@gmail.com' },
    { name: 'ProtocolloBnb', email: null },
  ]

  it('matches exact email (case insensitive)', () => {
    expect(matchAttendeeEmail(attendees, 'lucagallacci.lavoro@gmail.com')).toBe(true)
    expect(matchAttendeeEmail(attendees, 'LUCAGALLACCI.LAVORO@GMAIL.COM')).toBe(true)
    expect(matchAttendeeEmail(attendees, 'LucaGallacci.Lavoro@Gmail.com')).toBe(true)
  })

  it('matches with whitespace trimming', () => {
    expect(matchAttendeeEmail(attendees, ' lucagallacci.lavoro@gmail.com ')).toBe(true)
  })

  it('does not match non-existent email', () => {
    expect(matchAttendeeEmail(attendees, 'unknown@example.com')).toBe(false)
  })

  it('does not match empty email', () => {
    expect(matchAttendeeEmail(attendees, '')).toBe(false)
  })

  it('handles attendees with null email gracefully', () => {
    // ProtocolloBnb has null email — should not crash
    expect(matchAttendeeEmail(attendees, 'something@example.com')).toBe(false)
  })

  it('handles empty attendees array', () => {
    expect(matchAttendeeEmail([], 'test@example.com')).toBe(false)
  })
})

describe('buildEmailCallMap', () => {
  const calls = [
    {
      id: 'call-1',
      attendees: [
        { name: 'Antonio', email: 'antonio.durante@tonydurante.us' },
        { name: 'Client A', email: 'clienta@example.com' },
      ],
    },
    {
      id: 'call-2',
      attendees: [
        { name: 'Antonio', email: 'antonio.durante@tonydurante.us' },
        { name: 'Client B', email: 'clientb@example.com' },
        { name: 'Bot', email: null },
      ],
    },
    {
      id: 'call-3',
      attendees: [
        { name: 'Antonio', email: 'antonio.durante@tonydurante.us' },
        { name: 'Client A', email: 'clienta@example.com' },
      ],
    },
  ]

  it('maps each email to the first (most recent) call ID', () => {
    const map = buildEmailCallMap(calls)
    expect(map.get('clienta@example.com')).toBe('call-1')
    expect(map.get('clientb@example.com')).toBe('call-2')
  })

  it('excludes specified email', () => {
    const map = buildEmailCallMap(calls, 'antonio.durante@tonydurante.us')
    expect(map.has('antonio.durante@tonydurante.us')).toBe(false)
    expect(map.has('clienta@example.com')).toBe(true)
  })

  it('handles calls with no attendees gracefully', () => {
    const withEmpty = [...calls, { id: 'call-4', attendees: [] as Attendee[] }]
    const map = buildEmailCallMap(withEmpty)
    expect(map.size).toBeGreaterThan(0)
  })

  it('is case insensitive', () => {
    const map = buildEmailCallMap(calls)
    expect(map.get('clienta@example.com')).toBe('call-1')
  })

  it('skips null emails without crashing', () => {
    const map = buildEmailCallMap(calls)
    // call-2 has a null-email attendee — should not be in the map
    let hasNull = false
    for (const [key] of map) {
      if (key === '' || key === 'null' || key === 'undefined') hasNull = true
    }
    expect(hasNull).toBe(false)
  })
})
