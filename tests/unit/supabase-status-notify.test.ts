import { describe, expect, it, vi } from 'vitest'
import { NOTICE_RECIPIENT_EMAILS, runStatusNotices, type NoticeStore } from '@/lib/infra/supabase-status-notify'
import type { FeedIncident } from '@/lib/infra/supabase-status'

const open: FeedIncident = { id: 'A', name: 'Storage uploads failing in us-east-1', status: 'identified', created_at: '2026-11-02T21:34:57Z', incident_updates: [{ status: 'identified', body: 'Working on a fix.', created_at: '2026-11-02T21:48:00Z' }] }
const done: FeedIncident = { ...open, status: 'resolved', resolved_at: '2026-11-02T22:48:45Z', incident_updates: [{ status: 'resolved', body: 'Stable; resolved.', created_at: '2026-11-02T22:48:45Z' }] }

function memoryStore() {
  const rows = new Map<string, { opened: boolean; resolved: boolean }>()
  const store: NoticeStore = {
    async claimOpened(i) { if (rows.has(i.id)) return false; rows.set(i.id, { opened: true, resolved: false }); return true },
    async claimResolved(i) { const r = rows.get(i.id); if (!r || !r.opened || r.resolved) return false; r.resolved = true; return true },
  }
  return { store, rows }
}
const NOW = Date.parse('2026-11-02T23:00:00Z')

describe('Supabase incident notices', () => {
  it('tells Antonio, Luca and Jodi (and nobody else)', () => {
    expect([...NOTICE_RECIPIENT_EMAILS].sort()).toEqual(['antonio.durante@tonydurante.us', 'jodi@tonydurante.us', 'luca@tonydurante.us'])
  })
  it('announces an incident that opened, naming Supabase and quoting it', async () => {
    const { store } = memoryStore(); const send = vi.fn().mockResolvedValue(3)
    const r = await runStatusNotices({ feed: [open], region: 'us-east-1', now: NOW, store, send })
    expect(r.opened).toEqual(['A']); expect(r.sent).toBe(3)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].body).toContain('Supabase reports an incident')
    expect(send.mock.calls[0][0].body).toContain('Storage uploads failing in us-east-1')
  })
  it('announces it only once, however many times the cron runs', async () => {
    const { store } = memoryStore(); const send = vi.fn().mockResolvedValue(1)
    for (let n = 0; n < 4; n++) await runStatusNotices({ feed: [open], region: 'us-east-1', now: NOW, store, send })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('two runs at the same moment cannot both announce (the store answers true to one)', async () => {
    const { store } = memoryStore(); const send = vi.fn().mockResolvedValue(1)
    await Promise.all([runStatusNotices({ feed: [open], region: 'us-east-1', now: NOW, store, send }), runStatusNotices({ feed: [open], region: 'us-east-1', now: NOW, store, send })])
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('says it is over once, only if it had said it opened', async () => {
    const { store } = memoryStore(); const send = vi.fn().mockResolvedValue(1)
    await runStatusNotices({ feed: [open], region: 'us-east-1', now: NOW, store, send })
    await runStatusNotices({ feed: [done], region: 'us-east-1', now: NOW, store, send })
    await runStatusNotices({ feed: [done], region: 'us-east-1', now: NOW, store, send })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].title).toBe('Supabase incident resolved')
  })
  it('an incident that was never announced open is not announced resolved either', async () => {
    const { store } = memoryStore(); const send = vi.fn().mockResolvedValue(1)
    const r = await runStatusNotices({ feed: [done], region: 'us-east-1', now: NOW, store, send })
    expect(r.resolved).toEqual([]); expect(send).not.toHaveBeenCalled()
  })
  it('ignores incidents in other regions and Supabase tooling incidents', async () => {
    const { store } = memoryStore(); const send = vi.fn().mockResolvedValue(1)
    const feed: FeedIncident[] = [{ ...open, id: 'B', name: 'Storage uploads failing in eu-west-2' }, { ...open, id: 'C', name: 'Logs degraded in multiple regions' }]
    const r = await runStatusNotices({ feed, region: 'us-east-1', now: NOW, store, send })
    expect(r.opened).toEqual([]); expect(send).not.toHaveBeenCalled()
  })
  it('a dry run lists what would be announced and records and sends nothing', async () => {
    const { store, rows } = memoryStore(); const send = vi.fn()
    const r = await runStatusNotices({ feed: [open], region: 'us-east-1', now: NOW, store, send, dryRun: true })
    expect(r.opened).toEqual(['A']); expect(rows.size).toBe(0); expect(send).not.toHaveBeenCalled()
  })
})
