import { describe, it, expect } from 'vitest'
import {
  directMessages, otherUserId, dmName, startThreadId, membersWithoutChat, initials,
  dayKey, dayLabel, timeLabel, groupByDay, seenState, isAudio, isImage, formatSize, clock, linkify,
  reactionSummary, snippet, quotedPreview, canEdit, canDelete, matchMessages, REACTION_EMOJIS,
  type TalkThread, type TalkMessage,
} from '@/lib/talk/chat-model'

const ME = 'a-me'
const dm = (id: string, other: string, last: string | null, extra: Partial<TalkThread> = {}): TalkThread => ({
  id, thread_type: 'dm', dm_key: [ME, other].sort().join(':'), archived_at: null, last_activity_at: last, ...extra,
})
const members = [{ id: ME, name: 'Antonio' }, { id: 'b-luca', name: 'Luca' }, { id: 'c-other', name: 'Cris' }]

describe('direct messages', () => {
  it('keeps only live direct messages, newest first', () => {
    const list = directMessages([
      dm('old', 'b-luca', '2026-09-01T00:00:00Z'),
      { ...dm('chan', 'x', '2026-10-09T00:00:00Z'), thread_type: 'channel' },
      dm('arch', 'c-other', '2026-10-01T00:00:00Z', { archived_at: '2026-10-02T00:00:00Z' }),
      dm('new', 'c-other', '2026-10-08T00:00:00Z'),
      dm('none', 'd', null),
    ])
    expect(list.map(t => t.id)).toEqual(['new', 'old', 'none'])
  })
  it('finds the other person, whichever side of the key I am', () => {
    expect(otherUserId('a-me:b-luca', ME)).toBe('b-luca')
    expect(otherUserId('b-luca:z-me', 'z-me')).toBe('b-luca')
    expect(otherUserId(null, ME)).toBeNull()
    expect(otherUserId('a-me:b-luca', null)).toBeNull()
    expect(otherUserId('a-me:a-me', ME)).toBeNull()
  })
  it('names the chat after the other person', () => {
    expect(dmName(dm('x', 'b-luca', null), ME, members)).toBe('Luca')
    expect(dmName(dm('x', 'unknown', null), ME, members)).toBe('Teammate')
  })
})

describe('startThreadId', () => {
  const dms = [dm('luca', 'b-luca', '2026-10-09T10:00:00Z'), dm('cris', 'c-other', '2026-10-01T00:00:00Z')]
  it('a valid requested chat wins', () => expect(startThreadId(dms, { wanted: 'cris', lastOpened: 'luca' })).toBe('cris'))
  it('then the one open last time', () => expect(startThreadId(dms, { wanted: 'nope', lastOpened: 'cris' })).toBe('cris'))
  it('then the most recent chat', () => expect(startThreadId(dms, {})).toBe('luca'))
  it('a requested chat that is not a direct message (a channel) is ignored', () => {
    expect(startThreadId(dms, { wanted: 'some-channel-id' })).toBe('luca')
  })
  it('null when there is no chat', () => expect(startThreadId([], {})).toBeNull())
})

describe('people without a chat yet', () => {
  it('lists teammates I have no direct message with, never me', () => {
    expect(membersWithoutChat([dm('luca', 'b-luca', null)], ME, members).map(m => m.id)).toEqual(['c-other'])
    expect(membersWithoutChat([], ME, members).map(m => m.id)).toEqual(['b-luca', 'c-other'])
  })
})

describe('initials', () => {
  it('works for one or two names and empty', () => {
    expect(initials('Luca')).toBe('L')
    expect(initials('Antonio Noel Durante')).toBe('AD')
    expect(initials('  ')).toBe('?')
  })
})

describe('days and times', () => {
  const now = new Date(2026, 9, 9, 15, 0, 0) // Oct 9 2026 local
  const at = (d: Date) => d.toISOString()
  it('labels today, yesterday and older days', () => {
    expect(dayLabel(at(new Date(2026, 9, 9, 8, 0)), now)).toBe('Today')
    expect(dayLabel(at(new Date(2026, 9, 8, 23, 0)), now)).toBe('Yesterday')
    expect(dayLabel(at(new Date(2026, 8, 20, 12, 0)), now)).toMatch(/^[A-Z][a-z]{2}, Sep 20$/)
    expect(dayLabel(at(new Date(2025, 11, 31, 12, 0)), now)).toMatch(/Dec 31, 2025$/)
  })
  it('formats the time in 24h', () => {
    expect(timeLabel(at(new Date(2026, 9, 9, 7, 5)))).toBe('07:05')
    expect(timeLabel(at(new Date(2026, 9, 9, 23, 59)))).toBe('23:59')
  })
  it('groups messages under their day, in order — a quoted reply (the server gives it a root_id) is shown, not hidden', () => {
    const msgs = [
      { id: '1', sender_id: ME, sender_name: 'A', message: 'a', created_at: at(new Date(2026, 9, 8, 9, 0)) },
      { id: '2', sender_id: 'b', sender_name: 'L', message: 'b', created_at: at(new Date(2026, 9, 8, 9, 5)) },
      { id: 'r', sender_id: 'b', sender_name: 'L', message: 'reply', created_at: at(new Date(2026, 9, 8, 9, 6)), root_id: '1' },
      { id: '3', sender_id: ME, sender_name: 'A', message: 'c', created_at: at(new Date(2026, 9, 9, 9, 0)) },
    ]
    const g = groupByDay(msgs, now)
    expect(g.map(x => [x.label, x.messages.map(m => m.id)])).toEqual([['Yesterday', ['1', '2', 'r']], ['Today', ['3']]])
    expect(dayKey(at(new Date(2026, 0, 5, 12)))).toBe('2026-01-05')
  })
})

describe('seenState', () => {
  const m = { created_at: '2026-10-09T10:00:00Z' }
  it('is seen once the other person has read up to it', () => {
    expect(seenState(m, '2026-10-09T10:00:00Z')).toBe('seen')
    expect(seenState(m, '2026-10-09T11:00:00Z')).toBe('seen')
  })
  it('is sent before that, or with no read information', () => {
    expect(seenState(m, '2026-10-09T09:59:59Z')).toBe('sent')
    expect(seenState(m, null)).toBe('sent')
    expect(seenState(m, undefined)).toBe('sent')
    expect(seenState(m, 'garbage')).toBe('sent')
  })
})

describe('attachments', () => {
  it('recognises audio and images by type, then by name', () => {
    expect(isAudio({ name: 'x', mime_type: 'audio/mp4' })).toBe(true)
    expect(isAudio({ name: 'voice-note.m4a' })).toBe(true)
    expect(isAudio({ name: 'photo.png', mime_type: 'image/png' })).toBe(false)
    expect(isAudio({ name: 'notes.pdf' })).toBe(false)
    expect(isImage({ name: 'x', mime_type: 'image/jpeg' })).toBe(true)
    expect(isImage({ name: 'a.HEIC' })).toBe(true)
    expect(isImage({ name: 'a.pdf' })).toBe(false)
  })
  it('formats sizes and the recording clock', () => {
    expect(formatSize(500)).toBe('500 B')
    expect(formatSize(2048)).toBe('2 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatSize(undefined)).toBe('')
    expect(formatSize(-1)).toBe('')
    expect(clock(7)).toBe('0:07')
    expect(clock(125.9)).toBe('2:05')
    expect(clock(-3)).toBe('0:00')
  })
})

describe('linkify', () => {
  it('makes only http(s) links clickable and keeps trailing punctuation out of them', () => {
    expect(linkify('see https://a.com/x, ok')).toEqual([{ text: 'see ' }, { text: 'https://a.com/x', href: 'https://a.com/x' }, { text: ', ok' }])
    expect(linkify('no links here')).toEqual([{ text: 'no links here' }])
    expect(linkify('javascript:alert(1) and ftp://x')).toEqual([{ text: 'javascript:alert(1) and ftp://x' }])
    expect(linkify('')).toEqual([{ text: '' }])
  })
})

const msg = (over: Partial<TalkMessage> = {}): TalkMessage => ({ id: 'm', sender_id: ME, sender_name: 'Antonio', message: 'hello', created_at: '2026-10-09T10:00:00Z', ...over })

describe('reactionSummary', () => {
  it('groups by emoji in first-used order and marks mine', () => {
    const pills = reactionSummary([
      { emoji: '👍', reactor_id: 'b' }, { emoji: '❤️', reactor_id: ME }, { emoji: '👍', reactor_id: ME }, { emoji: '', reactor_id: 'x' },
    ], ME)
    expect(pills).toEqual([{ emoji: '👍', count: 2, mine: true }, { emoji: '❤️', count: 1, mine: true }])
  })
  it('handles none / null', () => {
    expect(reactionSummary(null, ME)).toEqual([])
    expect(reactionSummary([{ emoji: '🙏', reactor_id: 'b' }], null)).toEqual([{ emoji: '🙏', count: 1, mine: false }])
  })
  it('offers the six quick reactions', () => expect(REACTION_EMOJIS).toHaveLength(6))
})

describe('snippet', () => {
  it('shows text, trimmed and cut', () => {
    expect(snippet(msg({ message: '  hi   there ' }))).toBe('hi there')
    expect(snippet(msg({ message: 'x'.repeat(200) }), 20)).toBe('x'.repeat(19) + '…')
  })
  it('describes what a message carries when it has no text', () => {
    expect(snippet(msg({ message: '', attachments: [{ url: 'u', name: 'v.m4a', mime_type: 'audio/mp4' }] }))).toBe('🎤 Voice message')
    expect(snippet(msg({ message: '', attachments: [{ url: 'u', name: 'p.png', mime_type: 'image/png' }] }))).toBe('📷 Photo')
    expect(snippet(msg({ message: '', attachments: [{ url: 'u', name: 'a.pdf' }] }))).toBe('📎 a.pdf')
    expect(snippet(msg({ message: '' }))).toBe('Message')
  })
  it('never reveals a deleted message', () => expect(snippet(msg({ deleted_at: '2026-10-09T11:00:00Z' }))).toBe('Message deleted'))
})

describe('quotedPreview', () => {
  const orig = msg({ id: 'o', sender_name: 'Luca', message: 'original' })
  const byId = new Map([[orig.id, orig]])
  it('is null when the message quotes nothing', () => expect(quotedPreview(msg(), byId)).toBeNull())
  it('prefers the loaded message, so an edit or delete shows up in the quote', () => {
    expect(quotedPreview(msg({ reply_to_id: 'o', reply_to_preview: { id: 'o', message: 'stale', sender_name: 'Luca', deleted_at: null } }), byId))
      .toEqual({ id: 'o', sender_name: 'Luca', text: 'original' })
  })
  it('falls back to the server preview, then to a bare marker', () => {
    expect(quotedPreview(msg({ reply_to_id: 'far', reply_to_preview: { id: 'far', message: 'old one', sender_name: 'Luca', deleted_at: null } }), byId))
      .toEqual({ id: 'far', sender_name: 'Luca', text: 'old one' })
    expect(quotedPreview(msg({ reply_to_id: 'gone' }), byId)).toEqual({ id: 'gone', sender_name: '', text: 'Message' })
  })
})

describe('edit / delete rules', () => {
  it('only my own live text message can be edited', () => {
    expect(canEdit(msg(), ME)).toBe(true)
    expect(canEdit(msg({ sender_id: 'b' }), ME)).toBe(false)
    expect(canEdit(msg({ deleted_at: 'x' }), ME)).toBe(false)
    expect(canEdit(msg({ attachments: [{ url: 'u', name: 'n' }] }), ME)).toBe(false)
    expect(canEdit(msg({ message: '' }), ME)).toBe(false)
    expect(canEdit(msg(), null)).toBe(false)
  })
  it('only my own message can be deleted, once', () => {
    expect(canDelete(msg(), ME)).toBe(true)
    expect(canDelete(msg({ attachments: [{ url: 'u', name: 'n' }] }), ME)).toBe(true)
    expect(canDelete(msg({ sender_id: 'b' }), ME)).toBe(false)
    expect(canDelete(msg({ deleted_at: 'x' }), ME)).toBe(false)
  })
})

describe('matchMessages', () => {
  const list = [
    msg({ id: '1', message: 'Invoice for Acme' }),
    msg({ id: '2', message: 'lunch?' }),
    msg({ id: '3', message: '', attachments: [{ url: 'u', name: 'acme-contract.pdf' }] }),
    msg({ id: '4', message: 'acme again', deleted_at: 'x' }),
    msg({ id: '5', message: 'reply acme', root_id: '1' }),
  ]
  it('finds text and file names, newest first, skipping deleted ones', () => {
    expect(matchMessages(list, 'ACME').map(m => m.id)).toEqual(['5', '3', '1'])
  })
  it('needs two characters', () => {
    expect(matchMessages(list, 'a')).toEqual([])
    expect(matchMessages(list, '  ')).toEqual([])
  })
})
