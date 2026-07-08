import { describe, it, expect } from 'vitest'
import {
  buildInboxWorkerSystemPrompt,
  buildInboxWorkerUserBody,
} from '@/lib/ai-agent/inbox-worker-prompt'
import { SLACK_WORKER_SYSTEM_PROMPT } from '@/lib/ai-agent/slack-claude'

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
