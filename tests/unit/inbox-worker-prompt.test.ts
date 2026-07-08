import { describe, it, expect } from 'vitest'
import {
  buildInboxWorkerSystemPrompt,
  buildInboxWorkerUserBody,
  buildWorkerSurfacePrompt,
  buildClientWorkerUserBody,
  deterministicThreadUuid,
} from '@/lib/ai-agent/inbox-worker-prompt'
import { SLACK_WORKER_SYSTEM_PROMPT } from '@/lib/ai-agent/slack-claude'

describe('deterministicThreadUuid', () => {
  it('is a valid UUID, stable for the same scope, distinct across scopes', () => {
    const a = deterministicThreadUuid('inbox-support-19f428d9b3eb63a1')
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(deterministicThreadUuid('inbox-support-19f428d9b3eb63a1')).toBe(a)
    expect(deterministicThreadUuid('chat-acct-123')).not.toBe(a)
    expect(deterministicThreadUuid('')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('buildWorkerSurfacePrompt', () => {
  it('portal-chats surface is the Slack persona + portal override', () => {
    const prompt = buildWorkerSurfacePrompt('portal-chats')
    expect(prompt.startsWith(SLACK_WORKER_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).toContain('SURFACE OVERRIDE — PORTAL CHATS')
  })
})

describe('displayUserMessage', () => {
  it('prefers the recorded raw message', async () => {
    const { displayUserMessage } = await import('@/lib/ai-agent/inbox-worker-prompt')
    expect(displayUserMessage('big context blob\n\nStaff member: draft a reply', { user_message: 'draft a reply' }))
      .toBe('draft a reply')
  })
  it('falls back to extracting after the Staff member marker, then the body', async () => {
    const { displayUserMessage } = await import('@/lib/ai-agent/inbox-worker-prompt')
    expect(displayUserMessage('ctx\nStaff member: who is he?', null)).toBe('who is he?')
    expect(displayUserMessage('plain message', null)).toBe('plain message')
  })
})

describe('buildClientWorkerUserBody', () => {
  it('prefixes the client context when a name is given', () => {
    const body = buildClientWorkerUserBody('summarize their state', { name: 'Unique Commerce LLC' })
    expect(body).toContain('PORTAL CHATS CONTEXT')
    expect(body).toContain('Unique Commerce LLC')
    expect(body).toContain('Staff member: summarize their state')
  })
  it('passes through without a client', () => {
    expect(buildClientWorkerUserBody('hi', null)).toBe('hi')
  })
})

describe('buildInboxWorkerSystemPrompt', () => {
  it('is the Slack persona verbatim plus the inbox surface override', () => {
    const prompt = buildInboxWorkerSystemPrompt()
    expect(prompt.startsWith(SLACK_WORKER_SYSTEM_PROMPT)).toBe(true)
    expect(prompt).toContain('SURFACE OVERRIDE — CRM INBOX')
    expect(prompt).toContain('You are NOT in Slack right now')
  })
})

describe('buildInboxWorkerUserBody', () => {
  it('prefixes the email context on the first turn', () => {
    const body = buildInboxWorkerUserBody('who is this client?', {
      subject: 'Urgent: ITIN Application',
      sender: 'Tamás Fazekas',
      mailbox: 'support',
      latestMessage: 'Hi Tony, I hope you are doing well',
    })
    expect(body).toContain('CRM INBOX CONTEXT')
    expect(body).toContain('Subject: Urgent: ITIN Application')
    expect(body).toContain('From: Tamás Fazekas')
    expect(body).toContain('Mailbox: support@')
    expect(body).toContain('Staff member: who is this client?')
  })

  it('prefers the server-built transcript and includes the gmail_read_thread hint', () => {
    const body = buildInboxWorkerUserBody('explain this email', {
      subject: 'LLC',
      transcript: '--- Tamás (Jul 8) ---\nHi Tony, what is the difference between SMLLC and MMLLC?',
      latestMessage: 'snippet that should NOT be used',
      gmailThreadId: 'abc123',
      mailboxAddress: 'support@tonydurante.us',
    })
    expect(body).toContain('THREAD TRANSCRIPT')
    expect(body).toContain('SMLLC and MMLLC')
    expect(body).not.toContain('snippet that should NOT be used')
    expect(body).toContain('gmail_read_thread')
    expect(body).toContain('abc123')
  })

  it('passes the message through without context (later turns)', () => {
    expect(buildInboxWorkerUserBody('and the deadlines?', null)).toBe('and the deadlines?')
  })

  it('caps a huge latest message at 6000 chars', () => {
    const body = buildInboxWorkerUserBody('summarize', {
      latestMessage: 'x'.repeat(20000),
    })
    expect(body.length).toBeLessThan(7000)
  })
})
