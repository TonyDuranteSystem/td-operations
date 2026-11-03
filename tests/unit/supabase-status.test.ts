import { describe, expect, it } from 'vitest'
import {
  CLIENT_UPLOAD_MESSAGE, failureHint, isOpen, isRelevantToUs, mentionsOtherRegion, openRelevantIncidents, recentlyResolvedRelevant, staffMessage, toIncident, utcClock,
  type FeedIncident,
} from '@/lib/infra/supabase-status'

// the real incident of 2 Nov 2026, as Supabase's feed wrote it
const STORAGE_INCIDENT: FeedIncident = {
  id: '01M6F2ZNF7YMPS3V144BFQ72BD', name: 'Storage uploads failing in us-east-1', status: 'monitoring', created_at: '2026-11-02T21:34:57Z', resolved_at: null,
  incident_updates: [
    { status: 'monitoring', body: 'The fix has been implemented, and we are seeing Storage uploads return to normal.', created_at: '2026-11-02T22:23:00Z' },
    { status: 'identified', body: 'We have identified the issue causing Storage uploads to fail and are working on a fix.', created_at: '2026-11-02T21:48:00Z' },
    { status: 'investigating', body: 'We are investigating an error with Storage uploads returning 5xx errors for us-east-1 users.', created_at: '2026-11-02T21:34:00Z' },
  ],
}
const inc = (name: string, status = 'investigating'): FeedIncident => ({ id: name, name, status, created_at: '2026-11-02T10:00:00Z', incident_updates: [] })

describe('which incidents can hurt us', () => {
  it('the 2 Nov storage incident, in our region, does', () => {
    expect(isRelevantToUs(STORAGE_INCIDENT, 'us-east-1')).toBe(true)
  })
  it('the same incident in another region does not', () => {
    expect(isRelevantToUs(inc('Storage uploads failing in eu-west-2'), 'us-east-1')).toBe(false)
    expect(mentionsOtherRegion('Storage uploads failing in eu-west-2', 'us-east-1')).toBe(true)
  })
  it('"multiple regions", "all regions" and no region at all count as ours', () => {
    expect(isRelevantToUs(inc('Database connection errors in multiple regions'), 'us-east-1')).toBe(true)
    expect(isRelevantToUs(inc('Auth errors in all regions'), 'us-east-1')).toBe(true)
    expect(isRelevantToUs(inc('Realtime degraded'), 'us-east-1')).toBe(true)
  })
  it('Supabase tooling incidents never matter (logs, dashboard, support, project creation, management api)', () => {
    for (const n of ['Logs degraded in multiple regions', 'Log Drain Issues', 'Support Form Errors', 'Project creation errors ap-ne1', 'Elevated Mgmt API Error Rates in Multiple Regions', 'Delayed Log Delivery from 14:10 - 15:30 UTC', 'Dashboard login errors']) {
      expect(isRelevantToUs(inc(n), 'us-east-1'), n).toBe(false)
    }
  })
  it('a title that names a service we stand on AND a tooling word still matters', () => {
    expect(isRelevantToUs(inc('Database errors visible in logs'), 'us-east-1')).toBe(true)
  })
  it('the region is compared case-insensitively', () => {
    expect(isRelevantToUs(STORAGE_INCIDENT, 'US-EAST-1')).toBe(true)
  })
})

describe('open vs finished', () => {
  it('resolved and postmortem are finished; everything else is open', () => {
    expect(isOpen({ status: 'resolved' })).toBe(false)
    expect(isOpen({ status: 'postmortem' })).toBe(false)
    for (const s of ['investigating', 'identified', 'monitoring', 'update']) expect(isOpen({ status: s })).toBe(true)
  })
  it('only open, relevant incidents come back, newest first', () => {
    const older = { ...inc('Database connection errors', 'identified'), created_at: '2026-11-02T08:00:00Z' }
    const list = openRelevantIncidents([older, STORAGE_INCIDENT, { ...STORAGE_INCIDENT, id: 'done', status: 'resolved' }, inc('Logs degraded', 'identified')], 'us-east-1')
    expect(list.map(i => i.id)).toEqual([STORAGE_INCIDENT.id, older.id])
  })
})

describe('the words shown', () => {
  it('takes the title, the start and the NEWEST update from Supabase, unchanged', () => {
    const i = toIncident(STORAGE_INCIDENT)
    expect(i.title).toBe('Storage uploads failing in us-east-1')
    expect(i.latestUpdate).toBe('The fix has been implemented, and we are seeing Storage uploads return to normal.')
    expect(i.latestUpdateAt).toBe('2026-11-02T22:23:00Z')
    expect(i.affectsUploads).toBe(true)
  })
  it('the staff message names Supabase, quotes the incident and says it is not their connection', () => {
    const m = staffMessage(toIncident(STORAGE_INCIDENT))
    expect(m).toContain('Supabase reports an incident')
    expect(m).toContain('“Storage uploads failing in us-east-1”')
    expect(m).toContain('21:34 UTC')
    expect(m).toContain('22:23 UTC')
    expect(m).toContain('Files may not save')
    expect(m).toContain('not your connection')
  })
  it('a non-storage incident does not promise files will not save', () => {
    const m = staffMessage(toIncident(inc('Database connection errors', 'identified')))
    expect(m).not.toContain('Files may not save')
    expect(m).toContain('Some things may not work')
  })
  it('the failed-upload hint exists only for a storage incident', () => {
    expect(failureHint(toIncident(STORAGE_INCIDENT))).toContain('Supabase has an open storage incident')
    expect(failureHint(toIncident(inc('Database connection errors', 'identified')))).toBeNull()
  })
  it('clients are never told the cause', () => {
    expect(CLIENT_UPLOAD_MESSAGE).toBe('Uploads are temporarily unavailable, please try again shortly.')
    expect(CLIENT_UPLOAD_MESSAGE.toLowerCase()).not.toContain('supabase')
  })
  it('utcClock writes the time with its zone, and nothing for a bad date', () => {
    expect(utcClock('2026-11-02T21:34:57Z')).toBe('21:34 UTC')
    expect(utcClock('nope')).toBe('')
  })
})

describe('recently resolved', () => {
  const done: FeedIncident = { ...STORAGE_INCIDENT, status: 'resolved', resolved_at: '2026-11-02T22:48:45Z' }
  it('an incident that ended within the window is returned', () => {
    expect(recentlyResolvedRelevant([done], Date.parse('2026-11-02T23:00:00Z'), 24 * 3600_000, 'us-east-1')).toHaveLength(1)
  })
  it('one that ended long ago is not', () => {
    expect(recentlyResolvedRelevant([done], Date.parse('2026-11-05T23:00:00Z'), 24 * 3600_000, 'us-east-1')).toHaveLength(0)
  })
  it('an open one is not', () => {
    expect(recentlyResolvedRelevant([STORAGE_INCIDENT], Date.parse('2026-11-02T23:00:00Z'), 24 * 3600_000, 'us-east-1')).toHaveLength(0)
  })
})

import { incidentHintFor, statusUrlForPath, type IncidentState } from '@/lib/infra/incident-client'

describe('what the browser does with the answer', () => {
  const staff = (incident: ReturnType<typeof toIncident> | null): IncidentState => ({ audience: 'staff', incident, others: 0 })
  it('a staff person with an open storage incident gets the Supabase hint for a failed upload', () => {
    expect(incidentHintFor(staff(toIncident(STORAGE_INCIDENT)))).toContain('Supabase has an open storage incident')
  })
  it('no hint without an incident, for a non-storage incident, for a client, or when the feed is unknown', () => {
    expect(incidentHintFor(staff(null))).toBeNull()
    expect(incidentHintFor(staff(toIncident(inc('Database connection errors', 'identified'))))).toBeNull()
    expect(incidentHintFor({ audience: 'client', uploadsDown: true })).toBeNull()
    expect(incidentHintFor({ unknown: true })).toBeNull()
    expect(incidentHintFor(null)).toBeNull()
  })
  it('each kind of login asks the address its door rule allows', () => {
    expect(statusUrlForPath('/marketing/leads')).toBe('/api/marketing/supabase-status')
    expect(statusUrlForPath('/portal/chat')).toBe('/api/portal/supabase-status')
    expect(statusUrlForPath('/talk')).toBe('/api/infra/supabase-status')
    expect(statusUrlForPath('/')).toBe('/api/infra/supabase-status')
  })
})
