import { describe, it, expect } from 'vitest'
import {
  mailboxForAddress,
  parsePushMessage,
  GMAIL_PUSH_TOPIC,
} from '@/lib/gmail-push'

function pushBody(payload: unknown) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString('base64url'),
      messageId: '123',
    },
    subscription: 'projects/x/subscriptions/gmail-push-sub',
  }
}

describe('mailboxForAddress', () => {
  it('maps both watched mailboxes, case-insensitively', () => {
    expect(mailboxForAddress('support@tonydurante.us')).toBe('support')
    expect(mailboxForAddress('Antonio.Durante@TonyDurante.us')).toBe('antonio')
  })

  it('rejects unknown addresses and empty input', () => {
    expect(mailboxForAddress('client@example.com')).toBeNull()
    expect(mailboxForAddress('')).toBeNull()
    expect(mailboxForAddress(null)).toBeNull()
  })
})

describe('parsePushMessage', () => {
  it('decodes a Gmail notification (numeric historyId → string)', () => {
    const parsed = parsePushMessage(
      pushBody({ emailAddress: 'support@tonydurante.us', historyId: 987654 })
    )
    expect(parsed).toEqual({
      emailAddress: 'support@tonydurante.us',
      historyId: '987654',
    })
  })

  it('returns null for missing data, malformed base64, or incomplete payloads', () => {
    expect(parsePushMessage({})).toBeNull()
    expect(parsePushMessage({ message: {} })).toBeNull()
    expect(parsePushMessage({ message: { data: '!!!not-base64-json!!!' } })).toBeNull()
    expect(parsePushMessage(pushBody({ emailAddress: 'x@y.com' }))).toBeNull()
    expect(parsePushMessage(pushBody({ historyId: 1 }))).toBeNull()
  })
})

describe('GMAIL_PUSH_TOPIC', () => {
  it('points at the gmail-push topic in the SA project by default', () => {
    expect(GMAIL_PUSH_TOPIC).toBe(
      'projects/claude-gmail-connector-488713/topics/gmail-push'
    )
  })
})
