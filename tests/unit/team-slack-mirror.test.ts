import { describe, it, expect } from 'vitest'
import { slackTsToDate, classifySlackEvent, SKIP_SUBTYPES, resolveSlackMentions, KNOWN_SLACK_USERS } from '@/lib/team/slack-mirror-classify'

describe('resolveSlackMentions', () => {
  it('replaces known-user mentions with @Name', () => {
    expect(resolveSlackMentions('<@U0BAALR4Y4Q> please check')).toBe('@Antonio please check')
  })
  it('handles multiple + pipe-form mentions', () => {
    expect(resolveSlackMentions('<@U0B9ZUE2Q75|luca> and <@U0B9S675WTT>')).toBe('@Luca and @Claude')
  })
  it('leaves unknown ids as @id', () => {
    expect(resolveSlackMentions('<@U999>')).toBe('@U999')
  })
  it('passes plain text through', () => {
    expect(resolveSlackMentions('no mentions here')).toBe('no mentions here')
    expect(resolveSlackMentions('')).toBe('')
  })
  it('KNOWN_SLACK_USERS maps the core team', () => {
    expect(KNOWN_SLACK_USERS['U0BAALR4Y4Q']).toBe('Antonio')
  })
})

describe('slackTsToDate', () => {
  it('converts a Slack ts to a Date', () => {
    const d = slackTsToDate('1782141518.486979')
    expect(d).toBeInstanceOf(Date)
    expect(d!.getUTCFullYear()).toBe(2026)
  })
  it('returns null for garbage', () => {
    expect(slackTsToDate('')).toBeNull()
    expect(slackTsToDate('abc')).toBeNull()
    expect(slackTsToDate(null)).toBeNull()
    expect(slackTsToDate('0')).toBeNull()
  })
})

describe('classifySlackEvent', () => {
  it('upserts a normal channel message', () => {
    const a = classifySlackEvent({ type: 'message', channel: 'C1', ts: '1782141518.4', user: 'U1', text: 'hello' })
    expect(a.op).toBe('upsert')
    if (a.op === 'upsert') {
      expect(a.row.channel_id).toBe('C1')
      expect(a.row.ts).toBe('1782141518.4')
      expect(a.row.slack_user_id).toBe('U1')
      expect(a.row.text).toBe('hello')
      expect(a.row.edited).toBe(false)
      expect(a.row.posted_at).toBeTruthy()
    }
  })

  it('captures thread_ts on a reply', () => {
    const a = classifySlackEvent({ type: 'message', channel: 'C1', ts: '2.0', thread_ts: '1.0', user: 'U1', text: 'reply' })
    expect(a.op === 'upsert' && a.row.thread_ts).toBe('1.0')
  })

  it('handles an edit (message_changed) using event.message', () => {
    const a = classifySlackEvent({
      type: 'message', subtype: 'message_changed', channel: 'C1',
      message: { ts: '1782141518.4', user: 'U1', text: 'edited text' },
      previous_message: { ts: '1782141518.4', text: 'old' },
    })
    expect(a.op).toBe('upsert')
    if (a.op === 'upsert') {
      expect(a.row.text).toBe('edited text')
      expect(a.row.edited).toBe(true)
      expect(a.row.ts).toBe('1782141518.4')
    }
  })

  it('handles a delete (message_deleted)', () => {
    const a = classifySlackEvent({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: '1782141518.4' })
    expect(a).toEqual({ op: 'delete', channel_id: 'C1', ts: '1782141518.4' })
  })

  it('skips channel-noise subtypes', () => {
    for (const st of Array.from(SKIP_SUBTYPES)) {
      expect(classifySlackEvent({ type: 'message', subtype: st, channel: 'C1', ts: '1.0' }).op).toBe('skip')
    }
  })

  it('keeps file_share and bot_message (real content)', () => {
    expect(classifySlackEvent({ type: 'message', subtype: 'file_share', channel: 'C1', ts: '1.0', user: 'U1', text: 'file' }).op).toBe('upsert')
    const bot = classifySlackEvent({ type: 'message', subtype: 'bot_message', channel: 'C1', ts: '1.0', username: 'GitHub', text: 'PR' })
    expect(bot.op).toBe('upsert')
    if (bot.op === 'upsert') expect(bot.row.author_name).toBe('GitHub')
  })

  it('skips non-message events', () => {
    expect(classifySlackEvent({ type: 'reaction_added' }).op).toBe('skip')
    expect(classifySlackEvent(null).op).toBe('skip')
  })

  it('skips a message missing channel or ts', () => {
    expect(classifySlackEvent({ type: 'message', channel: 'C1' }).op).toBe('skip')
    expect(classifySlackEvent({ type: 'message', ts: '1.0' }).op).toBe('skip')
  })
})
