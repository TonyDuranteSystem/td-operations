import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ gmailPost: vi.fn(), reportSystemError: vi.fn(), tables: {} as Record<string, unknown> }))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: (t: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.tables[t] ?? null, error: null }) }) }) }) },
}))
vi.mock('@/lib/gmail', () => ({ gmailPost: h.gmailPost }))
vi.mock('@/lib/system-errors', () => ({ reportSystemError: h.reportSystemError }))

import { handleTeamChangeNotice } from '@/lib/jobs/handlers/team-change-notice'
import type { Job } from '@/lib/jobs/queue'

const job = (payload: Record<string, unknown>, attempts = 0, max = 8): Job => ({
  id: 'j1', job_type: 'team_change_notice', payload, status: 'processing', priority: 3, result: null, error: null, attempts, max_attempts: max,
  created_at: '', started_at: null, completed_at: null, created_by: 'team-notice', account_id: 'a1', lead_id: null, related_entity_type: null, related_entity_id: null,
})
const payload = { recipient_contact_id: 'c2', team_member_id: 't1', account_id: 'a1', kind: 'added', actor_contact_id: 'c1', added_keys: [], at: '2026-11-18T20:12:00.000Z' }
const decode = (raw: string): { subject: string; html: string; to: string } => {
  const text = Buffer.from(raw, 'base64url').toString()
  const subject = /Subject: =\?utf-8\?B\?([^?]+)\?=/.exec(text)?.[1]
  const body = /base64\r\n\r\n([A-Za-z0-9+/=]+)\r\n--/.exec(text)?.[1]
  return { subject: Buffer.from(subject ?? '', 'base64').toString(), html: Buffer.from(body ?? '', 'base64').toString(), to: /To: (.+)\r\n/.exec(text)?.[1] ?? '' }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.gmailPost.mockResolvedValue({ id: 'g1' })
  h.reportSystemError.mockResolvedValue(null)
  h.tables = {
    contacts: { full_name: 'Marco Bianchi', email: 'marco@example.com', language: 'English' },
    portal_team_members: { display_name: 'Anna Rossi', capabilities: { documents: true, chat: true } },
    accounts: { company_name: 'Acme LLC' },
  }
})

describe('job team_change_notice', () => {
  it('sends the email to the recipient, from support, with an encoded subject and the powers', async () => {
    const r = await handleTeamChangeNotice(job(payload))
    expect(r.steps[0]).toMatchObject({ name: 'send_email', status: 'ok' })
    expect(h.gmailPost).toHaveBeenCalledTimes(1)
    const sent = decode((h.gmailPost.mock.calls[0][1] as { raw: string }).raw)
    expect(sent.to).toBe('marco@example.com')
    expect(sent.subject).toBe('New team access at Acme LLC: Anna Rossi')
    expect(sent.html).toContain('<li>Documents</li><li>Chat</li>')
    expect(sent.html).toContain('/portal/team')
  })
  it('writes in Italian for an Italian recipient', async () => {
    h.tables.contacts = { full_name: 'Marco Bianchi', email: 'marco@example.com', language: 'Italiano' }
    await handleTeamChangeNotice(job(payload))
    expect(decode((h.gmailPost.mock.calls[0][1] as { raw: string }).raw).subject).toBe('Nuovo accesso al team di Acme LLC: Anna Rossi')
  })
  it('names the new powers for a "more" notice', async () => {
    await handleTeamChangeNotice(job({ ...payload, kind: 'more', added_keys: ['chat'] }))
    const sent = decode((h.gmailPost.mock.calls[0][1] as { raw: string }).raw)
    expect(sent.subject).toBe('Team access changed at Acme LLC: Anna Rossi')
    expect(sent.html).toContain('New powers: Chat.')
  })
  it('skips (and finishes, no retry) a recipient with no email, a missing person, or a broken payload', async () => {
    h.tables.contacts = { full_name: 'No Mail', email: null, language: null }
    expect(await handleTeamChangeNotice(job(payload))).toMatchObject({ terminal: true })
    h.tables.contacts = { full_name: 'M', email: 'm@x.com', language: null }; h.tables.portal_team_members = null as unknown as undefined
    expect(await handleTeamChangeNotice(job(payload))).toMatchObject({ terminal: true })
    expect(await handleTeamChangeNotice(job({ ...payload, recipient_contact_id: undefined }))).toMatchObject({ terminal: true })
    expect(h.gmailPost).not.toHaveBeenCalled()
  })
  it('a failed send throws so the queue tries again, and is only reported as a system error on the LAST try', async () => {
    h.gmailPost.mockRejectedValue(new Error('gmail down'))
    await expect(handleTeamChangeNotice(job(payload, 0, 8))).rejects.toThrow('gmail down')
    expect(h.reportSystemError).not.toHaveBeenCalled()
    await expect(handleTeamChangeNotice(job(payload, 7, 8))).rejects.toThrow('gmail down')
    expect(h.reportSystemError).toHaveBeenCalledTimes(1)
    expect(h.reportSystemError.mock.calls[0][0]).toMatchObject({ source: 'server', route: 'job:team_change_notice' })
  })
})

describe('the job is registered', () => {
  it('the worker knows team_change_notice', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync('lib/jobs/registry.ts', 'utf8')).toContain('team_change_notice: handleTeamChangeNotice')
  })
})
